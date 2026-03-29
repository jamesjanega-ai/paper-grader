// ============================================================
// server.js — Innovation Paper Grader v4
//
// ARCHITECTURE: Three separate endpoints
//   /grade-round    — one round: 4 parallel per-question calls
//   /grade-synthesize — narrative summary + coaching + Sheets log
//   /health         — wake-up ping
//
// Client makes: 3× /grade-round (sequential) + 1× /grade-synthesize
// Client aggregates rounds and identifies median run
// Halo effect impossible: coaching never sees the paper
// ============================================================

const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));


// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.send('Innovation Paper Grader v4 is running.');
});


// ============================================================
// /grade-round
// Runs ONE round: one Claude call per question, all in parallel.
// Returns array of per-question results.
// Called 3 times by the client for Monte Carlo averaging.
// ============================================================
app.post('/grade-round', async (req, res) => {
  try {
    const {
      chipContexts, priorityChipName,
      questions, rubricSelections,
      caseText, studentPaperText,
      harshness, adjustedScores, blindGrade
    } = req.body;

    const scores = adjustedScores || { absent:0, incomplete:0.25, partial:0.50, strong:0.75, mastery:1.0 };

    // Sequential question calls — one at a time, fully rate-limit safe.
    // Haiku processes each in ~12-15s. 4 questions ≈ 50-60s per round.
    // No parallelism = no token burst = no 500 errors regardless of org tier.
    const rawResults = [];
    for (let i = 0; i < questions.length; i++) {
      const text = await callClaudeWithTimeout(
        buildQuestionPrompt(
          chipContexts, priorityChipName, questions[i],
          rubricSelections[i] || [], caseText, studentPaperText,
          harshness, scores, blindGrade, i + 1
        ),
        3500,
        90000,
        'claude-haiku-4-5-20251001'
      );
      rawResults.push(text);
    }

    // Parse each question JSON
    const questionResults = rawResults.map((text, i) => {
      try {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('No JSON block found in response');
        const parsed = JSON.parse(match[0]);
        parsed.questionNumber = i + 1;
        // Ensure questionMax matches factor count
        if (!parsed.questionMax || parsed.questionMax === 0) {
          parsed.questionMax = (rubricSelections[i] || []).length;
        }
        return parsed;
      } catch (err) {
        console.error(`Q${i+1} parse error:`, err.message);
        // Return safe fallback so one failure doesn't kill the round
        return {
          questionNumber: i + 1,
          questionText: questions[i],
          factors: (rubricSelections[i] || []).map(f => ({
            factorName: f, evidence: 'Parse error', score: 0,
            justification: 'Could not parse response for this question.'
          })),
          questionTotal: 0,
          questionMax: (rubricSelections[i] || []).length,
          critique: 'Could not generate critique — see error log.',
          parseError: err.message
        };
      }
    });

    res.json({ success: true, questions: questionResults });

  } catch (err) {
    console.error('Round failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ============================================================
// /grade-synthesize
// Generates narrative summary + coaching feedback.
// Runs AFTER the client has aggregated all 3 rounds.
// Also saves the final averaged result to Google Sheets.
// ============================================================
app.post('/grade-synthesize', async (req, res) => {
  try {
    const {
      chipContexts, priorityChipName,
      aggregatedQuestions,
      totalScore, totalPossible, percentage, finalPoints,
      roundPcts, spread, pointsPossible,
      llmInteractions,
      year, section, caseName, team, harshness
    } = req.body;

    // Run narrative synthesis and coaching in parallel
    const [narrativeText, coaching] = await Promise.all([
      callClaudeWithTimeout(
        buildSynthesisPrompt(chipContexts, priorityChipName, aggregatedQuestions, totalScore, totalPossible, percentage),
        2000, 60000
      ),
      callClaudeCoaching(llmInteractions)
    ]);

    // Parse narrative JSON
    let narrativeSummary = null;
    try {
      const match = narrativeText.match(/\{[\s\S]*\}/);
      if (match) narrativeSummary = JSON.parse(match[0]);
    } catch (e) {
      console.warn('Narrative parse failed:', e.message);
      narrativeSummary = {
        superpower: 'Summary could not be generated this session.',
        improvements: '',
        watchFor: '',
        oneSentenceSummary: 'Summary unavailable.'
      };
    }

    // Log to Sheets (non-blocking)
    saveToSheets({
      aggregatedQuestions, totalScore, totalPossible, percentage,
      finalPoints, pointsPossible, roundPcts, spread,
      narrativeSummary,
      promptCoachingSummary: coaching.summary,
      year, section, caseName, team, harshness
    }).catch(err => console.error('Sheets save failed:', err.message));

    res.json({
      success: true,
      narrativeSummary,
      promptCoaching:        coaching.fullCoaching,
      promptCoachingSummary: coaching.summary
    });

  } catch (err) {
    console.error('Synthesize failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ============================================================
// callClaudeWithTimeout — shared API call with abort controller
// ============================================================
async function callClaudeWithTimeout(prompt, maxTokens, timeoutMs, model = 'claude-opus-4-5') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:       model,
        max_tokens:  maxTokens,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error('Claude API error: ' + (data.error?.message || 'Unknown'));
    return data.content[0].text;

  } finally {
    clearTimeout(timer);
  }
}


// ============================================================
// callClaudeCoaching — isolated coaching call
// NEVER receives student paper or case content.
// ============================================================
async function callClaudeCoaching(llmInteractions) {
  const DEFAULT = {
    summary:      'No LLM interactions provided.',
    fullCoaching: 'No LLM interactions provided.'
  };
  if (!llmInteractions || !llmInteractions.trim()) return DEFAULT;

  try {
    const raw = await callClaudeWithTimeout(buildCoachingPrompt(llmInteractions), 2000, 45000);
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.summary && parsed.fullCoaching) {
        return { summary: parsed.summary, fullCoaching: parsed.fullCoaching };
      }
    }
    const firstSentence = raw.split(/(?<=[.!?])\s/)[0] || raw.slice(0, 120);
    return { summary: firstSentence, fullCoaching: raw };
  } catch (err) {
    console.warn('Coaching call failed (non-fatal):', err.message);
    return {
      summary:      'Coaching unavailable this session.',
      fullCoaching: 'Prompt coaching could not be generated. Please review the interaction log manually.'
    };
  }
}


// ============================================================
// buildCoachingPrompt — receives ONLY the LLM interaction log
// ============================================================
function buildCoachingPrompt(llmInteractions) {
  return `You are a Prompt Engineering Coach evaluating how a student group used an AI assistant for a business case assignment.

Evaluate the QUALITY OF THEIR PROMPTING STRATEGY only. You have not seen their paper. Evaluate how skillfully they collaborated with the AI.

=== STUDENT LLM INTERACTION LOG ===
${llmInteractions}

=== STRENGTHS TO RECOGNIZE ===
- Using LLM as a thinking partner while retaining authorship
- Providing specific context, constraints, and rubric criteria upfront
- Stress-testing their own thesis before accepting an answer
- Asking for alternatives before recommendations
- Requesting the LLM to find weaknesses in their argument
- Iterating on substance before style

=== WEAKNESSES TO FLAG ===
- Pasting the assignment and asking for a finished answer
- Treating the LLM as a ghostwriter rather than a thought partner
- Framework pile-ons without analytical focus
- Accepting unsupported statistics or MBA jargon
- Asking for style polish before substance is solid

=== REQUIRED OUTPUT FORMAT ===
Return ONLY valid JSON. No markdown. No text outside the JSON.

{
  "summary": "One crisp sentence under 20 words for professor reference",
  "fullCoaching": "WHAT THEY DID WELL: [specific paragraph]. CRITICAL WEAKNESSES: [specific paragraph naming the pattern]. ACTIONABLE IMPROVEMENTS: [concrete paragraph]. Under 300 words total."
}`;
}


// ============================================================
// buildBehavioralAnchors — shared by all question prompts
// ============================================================
function buildBehavioralAnchors(scores) {
  return `=== BEHAVIORAL ANCHORS ===
Use these exact descriptions. Match the evidence to the description that fits best.

IDENTIFICATION OF KEY ISSUES:
  ${scores.absent}     = The response does not identify any relevant problem or challenge from the case.
  ${scores.incomplete} = The response mentions a problem but misidentifies or omits primary issues.
  ${scores.partial}    = The response identifies at least one correct issue but does not clearly distinguish primary vs. secondary issues.
  ${scores.strong}     = The response clearly identifies primary issues and acknowledges secondary ones with minor gaps.
  ${scores.mastery}    = The response explicitly identifies, prioritizes, and clearly distinguishes all primary and secondary issues in the case.

USE OF THEORETICAL FRAMEWORKS:
  ${scores.absent}     = No frameworks, models, or theories are used or referenced.
  ${scores.incomplete} = A framework is mentioned but incorrectly applied or not connected to the case.
  ${scores.partial}    = A relevant framework is applied but with limited accuracy or depth.
  ${scores.strong}     = Multiple relevant frameworks are correctly applied with clear links to the case.
  ${scores.mastery}    = Frameworks are precisely selected, correctly applied, and used to generate meaningful insights beyond surface-level analysis.

ANALYSIS AND CRITICAL THINKING:
  ${scores.absent}     = The response provides no meaningful analysis or interpretation of the case.
  ${scores.incomplete} = The response describes the case but does not analyze implications or perspectives.
  ${scores.partial}    = The response includes some analysis but lacks depth or consideration of alternative perspectives.
  ${scores.strong}     = The response provides clear, multi-perspective analysis with logical reasoning and implications.
  ${scores.mastery}    = The response delivers deep, structured analysis that evaluates tradeoffs, consequences, and competing perspectives rigorously.

DEVELOPMENT OF ALTERNATIVES:
  ${scores.absent}     = No alternatives or solutions are proposed.
  ${scores.incomplete} = Only one solution is proposed with no consideration of alternatives.
  ${scores.partial}    = Multiple alternatives are listed but lack meaningful comparison or evaluation.
  ${scores.strong}     = Multiple viable alternatives are presented with basic pros and cons.
  ${scores.mastery}    = Multiple high-quality alternatives are clearly compared using explicit criteria and tradeoffs.

RECOMMENDATIONS:
  ${scores.absent}     = No recommendation is provided.
  ${scores.incomplete} = A recommendation is stated but not connected to analysis.
  ${scores.partial}    = A recommendation is provided with limited reasoning or missing implications.
  ${scores.strong}     = A well-reasoned recommendation is supported by analysis with some consideration of implications.
  ${scores.mastery}    = A clear, prioritized recommendation is fully justified and includes both short-term and long-term implications.

JUSTIFICATION AND SUPPORT:
  ${scores.absent}     = No evidence, data, or case references are used.
  ${scores.incomplete} = Minimal or irrelevant evidence is included without clear linkage to arguments.
  ${scores.partial}    = Some relevant evidence is used but inconsistently or superficially.
  ${scores.strong}     = Arguments are supported with relevant case data or credible sources.
  ${scores.mastery}    = All key claims are explicitly supported with precise, relevant evidence or data from the case or external sources.

PROFESSIONAL WRITING SKILLS:
  ${scores.absent}     = Writing is unclear, unstructured, or contains major grammatical errors.
  ${scores.incomplete} = Writing is understandable but contains frequent errors or unclear phrasing.
  ${scores.partial}    = Writing is generally clear with minor errors that do not impede understanding.
  ${scores.strong}     = Writing is clear, professional, and mostly error-free.
  ${scores.mastery}    = Writing is concise, precise, polished, and fully professional with no noticeable errors.

ORGANIZATION AND COHERENCE:
  ${scores.absent}     = The response lacks structure and logical flow.
  ${scores.incomplete} = The response has minimal structure but ideas are loosely connected.
  ${scores.partial}    = The response follows a basic structure but transitions or flow are inconsistent.
  ${scores.strong}     = The response is logically organized with clear sections and progression.
  ${scores.mastery}    = The response is tightly structured with seamless flow, clear hierarchy, and strong narrative coherence.

CITATION AND REFERENCING:
  ${scores.absent}     = No citations are provided where required.
  ${scores.incomplete} = Citations are attempted but incorrect or incomplete.
  ${scores.partial}    = Some correct citations are included but inconsistently applied.
  ${scores.strong}     = Citations are mostly correct and consistently applied.
  ${scores.mastery}    = All sources are properly cited using the correct format with a complete reference list if applicable.

REALISM AND FEASIBILITY:
  ${scores.absent}     = Recommendations are unrealistic or ignore key constraints.
  ${scores.incomplete} = Recommendations show limited awareness of feasibility or constraints.
  ${scores.partial}    = Recommendations are somewhat realistic but overlook important constraints.
  ${scores.strong}     = Recommendations are practical and consider key financial, operational, or strategic constraints.
  ${scores.mastery}    = Recommendations are fully realistic, implementable, and explicitly account for constraints and execution complexity.

REFLECTION AND SELF-ASSESSMENT:
  ${scores.absent}     = No reflection or learning is included.
  ${scores.incomplete} = Reflection is vague or unrelated to the case.
  ${scores.partial}    = Reflection identifies learning but lacks depth or specificity.
  ${scores.strong}     = Reflection clearly identifies learning outcomes and some future questions.
  ${scores.mastery}    = Reflection is specific, insightful, and identifies clear next steps or areas for further inquiry.

CREATIVITY AND ORIGINALITY:
  ${scores.absent}     = No original thinking or novel ideas are present.
  ${scores.incomplete} = Ideas are generic or heavily derivative of common responses.
  ${scores.partial}    = Some original thinking is present but not fully developed.
  ${scores.strong}     = The response includes clear original insights or creative approaches.
  ${scores.mastery}    = The response demonstrates distinctive, novel thinking that meaningfully advances the analysis.

PROFESSIONALISM AND ETHICAL CONSIDERATIONS:
  ${scores.absent}     = No ethical considerations are addressed.
  ${scores.incomplete} = Ethical issues are mentioned but not analyzed.
  ${scores.partial}    = Ethical considerations are identified but not integrated into recommendations.
  ${scores.strong}     = Ethical implications are clearly discussed and linked to decisions.
  ${scores.mastery}    = Ethical considerations are deeply integrated into analysis and recommendations with stakeholder awareness.

COMMUNICATION SKILLS:
  ${scores.absent}     = Ideas are not effectively communicated or are difficult to understand.
  ${scores.incomplete} = Communication is inconsistent or unclear in key areas.
  ${scores.partial}    = Communication is generally clear but lacks precision or effectiveness.
  ${scores.strong}     = Communication is clear and appropriate with effective use of structure or visuals if applicable.
  ${scores.mastery}    = Communication is highly effective, precise, and tailored to the audience with strong clarity and impact.

PEER AND TEAM EVALUATION:
  ${scores.absent}     = No evidence of collaboration or contribution.
  ${scores.incomplete} = Minimal contribution or unclear role in team work.
  ${scores.partial}    = Some contribution is evident but inconsistent.
  ${scores.strong}     = Active and constructive participation in team efforts is demonstrated.
  ${scores.mastery}    = Clear, consistent, and value-adding contribution that improves overall team output is demonstrated.`;
}


// ============================================================
// buildQuestionPrompt — focused single-question grading prompt
// Deliberately omits llmInteractions entirely.
// Smaller context = less variance, more focused evidence search.
// ============================================================
function buildQuestionPrompt(chipContexts, priorityChipName, question, factors, caseText, studentPaperText, harshness, scores, blindGrade, questionNumber) {

  let frameworkSection = '';
  chipContexts.forEach(chip => {
    const isPriority = chip.name === priorityChipName;
    frameworkSection += `\n\n=== ${isPriority ? 'PRIORITY FRAMEWORK (weight most heavily)' : 'Supporting Framework'}: ${chip.name} ===\n${chip.content}`;
  });

  const blindNote = blindGrade
    ? '\nNOTE: BLIND GRADE SESSION. Grade the work only — no team identity provided.\n'
    : '';

  const factorList = factors.map(f => `  - ${f}`).join('\n');

  return `You are an expert Innovation professor grading ONE specific question from a student paper.
${blindNote}

=== GRADING FRAMEWORKS ===
PRIORITY framework carries the most weight.
${frameworkSection}


=== CASE STUDY TEXT ===
${caseText || '[No case text provided]'}


=== STUDENT PAPER ===
${studentPaperText || '[No student paper provided]'}


=== QUESTION ${questionNumber} — GRADE ONLY THIS QUESTION ===
${question}


=== RUBRIC FACTORS FOR THIS QUESTION ===
Grade ONLY these factors:
${factorList}


=== GRADING SCALE (Harshness: ${harshness || 100}%) ===
  Absent:      ${scores.absent}
  Incomplete:  ${scores.incomplete}
  Partial:     ${scores.partial}
  Strong:      ${scores.strong}
  Mastery:     ${scores.mastery}

Use ONLY these exact values. Do not round or substitute.


${buildBehavioralAnchors(scores)}


=== TWO-PASS GRADING ===
PASS 1 — FIND EVIDENCE: For each factor listed above, locate the specific sentence, phrase, or argument in the student paper that addresses this question and this factor. Quote it exactly. If no evidence exists, write "No evidence found." Grade only what is written.

PASS 2 — SCORE: Using only Pass 1 evidence, assign a score from the behavioral anchors above.


=== OUTPUT — CRITICAL ===
Grade ONLY Question ${questionNumber}. Return ONLY valid JSON. No markdown. No text outside the JSON.

{
  "questionNumber": ${questionNumber},
  "questionText": "paste the question text here",
  "factors": [
    {
      "factorName": "exact factor name as listed above",
      "evidence": "exact phrase from student paper, or No evidence found",
      "score": ${scores.strong},
      "justification": "one sentence tying this evidence to the behavioral anchor level"
    }
  ],
  "questionTotal": 2.25,
  "questionMax": ${factors.length}.0,
  "critique": "exactly 50 words critiquing this question's answer using the selected frameworks"
}`;
}


// ============================================================
// buildSynthesisPrompt — narrative summary from aggregated scores
// Receives already-computed averaged scores, not raw paper.
// ============================================================
function buildSynthesisPrompt(chipContexts, priorityChipName, aggregatedQuestions, totalScore, totalPossible, percentage) {

  const frameworkNames = chipContexts.map(c =>
    c.name === priorityChipName ? `${c.name} (PRIORITY)` : c.name
  ).join(', ');

  const questionSummaries = aggregatedQuestions.map(q => {
    const factorLines = (q.factors || []).map(f =>
      `    - ${f.factorName}: ${f.score.toFixed(2)} — ${f.justification || 'no justification'}`
    ).join('\n');
    return `Q${q.questionNumber} (${q.questionPct}%): ${q.questionText}\nCritique (median run): ${q.critique}\nFactor scores:\n${factorLines}`;
  }).join('\n\n');

  return `You are an Innovation professor writing a narrative performance summary.

This student group scored ${percentage.toFixed(1)}% overall on a business case paper evaluated using these frameworks: ${frameworkNames}.

=== GRADED QUESTION RESULTS (averaged across 3 runs) ===
${questionSummaries}

=== YOUR TASK ===
Write a GROUP NARRATIVE SUMMARY with four parts:
a. SUPERPOWER: 2-3 sentences identifying what this group genuinely did well — their insight strength and most impressive thinking
b. IMPROVEMENTS: 1-2 sentences each on where they should go deeper across these dimensions: (1) theoretical frameworks from class, (2) connection to evidence and data, (3) critical thinking and analysis, (4) development of alternatives and recommendations
c. WATCH FOR: ONE specific, practical, memorable thing to watch for if they encounter a similar case in real life — tied directly to their actual work in this paper
d. ONE-SENTENCE SUMMARY: A single crisp sentence the professor can read months later to remember this grading session

=== OUTPUT FORMAT ===
Return ONLY valid JSON. No markdown. No text outside the JSON.

{
  "superpower": "2-3 sentences on genuine group strength",
  "improvements": "paragraph covering all four improvement dimensions",
  "watchFor": "one specific practical sentence",
  "oneSentenceSummary": "one crisp sentence for professor memory"
}`;
}


// ============================================================
// saveToSheets — via Google Apps Script Web App
//
// Sheet columns (v4 with Monte Carlo):
// A: Timestamp       B: Year       C: Section    D: Case       E: Team
// F–O: Q1%–Q10%      P: Final%     Q: Points Earned  R: Points Possible
// S: Summary         T: Coaching   U: Harshness%
// V: Run 1%          W: Run 2%     X: Run 3%     Y: Spread     Z: Consistency
// ============================================================
async function saveToSheets(data) {
  try {
    if (!process.env.GOOGLE_SCRIPT_URL) {
      console.log('No GOOGLE_SCRIPT_URL — skipping Sheets save.');
      return;
    }

    const {
      aggregatedQuestions, totalScore, totalPossible, percentage,
      finalPoints, pointsPossible, roundPcts, spread,
      narrativeSummary, promptCoachingSummary,
      year, section, caseName, team, harshness
    } = data;

    // Q1–Q10 percentages from aggregated questions
    const qPcts = Array(10).fill('');
    (aggregatedQuestions || []).forEach((q, i) => {
      if (i < 10) qPcts[i] = q.questionPct !== undefined ? q.questionPct + '%' : '';
    });

    // Consistency rating from spread
    const spreadNum = parseFloat(spread) || 0;
    const consistency = spreadNum <= 2 ? 'High' : spreadNum <= 5 ? 'Moderate' : 'Variable';

    const payload = {
      timestamp:       new Date().toISOString(),
      year:            year            || '',
      section:         section         || '',
      caseName:        caseName        || '',
      team:            team            || '',
      q1:  qPcts[0],  q2:  qPcts[1],  q3:  qPcts[2],  q4:  qPcts[3],  q5:  qPcts[4],
      q6:  qPcts[5],  q7:  qPcts[6],  q8:  qPcts[7],  q9:  qPcts[8],  q10: qPcts[9],
      finalPct:        percentage      ? percentage.toFixed(1) + '%' : '',
      pointsEarned:    finalPoints     || '',
      pointsPossible:  pointsPossible  || '',
      summary:         narrativeSummary?.oneSentenceSummary || '',
      promptCoaching:  promptCoachingSummary || '',
      harshness:       harshness       ? harshness + '%' : '',
      run1:            roundPcts?.[0]  !== undefined ? roundPcts[0].toFixed(1) + '%' : '',
      run2:            roundPcts?.[1]  !== undefined ? roundPcts[1].toFixed(1) + '%' : '',
      run3:            roundPcts?.[2]  !== undefined ? roundPcts[2].toFixed(1) + '%' : '',
      spread:          spread          !== undefined ? parseFloat(spread).toFixed(1) + '%' : '',
      consistency
    };

    const response = await fetch(process.env.GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (result.success) console.log('Saved to Google Sheets.');
    else console.error('Apps Script error:', result.error);

  } catch (err) {
    console.error('Google Sheets error:', err.message);
  }
}


// ============================================================
// Start server
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Innovation Paper Grader v4 running on port ${PORT}`);
});
