// ============================================================
// server.js — Innovation Paper Grader v3
//
// TWO SEPARATE CLAUDE CALLS — prevents halo effect:
//   Call A (Grading):  paper + frameworks + rubric. Never sees LLM log.
//   Call B (Coaching): LLM log only. Never sees the paper.
//
// Both run in parallel. Individual timeouts prevent 502s on Render.
// If coaching call fails, grading still returns — never blocks.
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
  res.send('Innovation Paper Grader v3 is running.');
});

// ============================================================
// /grade
// ============================================================
app.post('/grade', async (req, res) => {
  try {
    const {
      chipContexts,
      priorityChipName,
      questions,
      rubricSelections,
      caseText,
      studentPaperText,
      llmInteractions,
      pointsPossible,
      year,
      section,
      caseName,
      team,
      harshness,
      adjustedScores,
      blindGrade
    } = req.body;

    // Build the grading prompt — llmInteractions deliberately NOT included
    const gradingPrompt = buildGradingPrompt(
      chipContexts, priorityChipName, questions, rubricSelections,
      caseText, studentPaperText, pointsPossible,
      harshness, adjustedScores, blindGrade
    );

    // Run grading and coaching in parallel with individual timeouts.
    // If coaching fails, we use a safe default — grading is never blocked.
    const [gradingText, coaching] = await Promise.all([
      callClaudeWithTimeout(gradingPrompt, 10000, 110000),   // grade: 110s timeout
      callClaudeCoaching(llmInteractions)                    // coach: fails safely
    ]);

    // Parse grading JSON
    const jsonMatch = gradingText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Claude did not return valid JSON. Raw: ' + gradingText.slice(0, 300));
    }
    const gradingResult = JSON.parse(jsonMatch[0]);

    // Attach coaching (from isolated call that never saw the paper)
    gradingResult.promptCoaching        = coaching.fullCoaching;
    gradingResult.promptCoachingSummary = coaching.summary;

    // Per-question percentages
    if (gradingResult.questions) {
      gradingResult.questions.forEach(q => {
        q.questionPct = q.questionMax > 0
          ? parseFloat(((q.questionTotal / q.questionMax) * 100).toFixed(1))
          : 0;
      });
    }

    // Save to Sheets (non-blocking — never delays the response)
    saveToSheets(gradingResult, req.body).catch(err =>
      console.error('Sheets save failed:', err.message)
    );

    res.json({ success: true, result: gradingResult });

  } catch (err) {
    console.error('Grading error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// callClaudeWithTimeout
// Wraps a Claude API call with an explicit timeout so Render
// never hangs past its limit and returns a 502.
// ============================================================
async function callClaudeWithTimeout(prompt, maxTokens, timeoutMs) {
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
        model:      'claude-opus-4-5',
        max_tokens: maxTokens,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error('Claude API error: ' + (data.error?.message || 'Unknown'));
    }
    return data.content[0].text;

  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// callClaudeCoaching
// Isolated call — NEVER receives the student paper.
// Returns safe defaults if it fails for any reason.
// ============================================================
async function callClaudeCoaching(llmInteractions) {
  const DEFAULT = {
    summary:      'No LLM interactions provided.',
    fullCoaching: 'No LLM interactions provided.'
  };

  if (!llmInteractions || !llmInteractions.trim()) return DEFAULT;

  try {
    const raw = await callClaudeWithTimeout(buildCoachingPrompt(llmInteractions), 2000, 45000);

    // Claude was asked to return JSON with summary + fullCoaching
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.summary && parsed.fullCoaching) {
        return { summary: parsed.summary, fullCoaching: parsed.fullCoaching };
      }
    }
    // Fallback: first sentence as summary
    const firstSentence = raw.split(/(?<=[.!?])\s/)[0] || raw.slice(0, 120);
    return { summary: firstSentence, fullCoaching: raw };

  } catch (err) {
    console.warn('Coaching call failed (non-fatal):', err.message);
    return {
      summary:      'Coaching unavailable — see full log.',
      fullCoaching: 'Prompt coaching could not be generated this session. Please review the interaction log manually.'
    };
  }
}

// ============================================================
// buildCoachingPrompt
// Receives ONLY the LLM interaction log.
// ============================================================
function buildCoachingPrompt(llmInteractions) {
  return `You are a Prompt Engineering Coach evaluating how a student group used an AI assistant for a business case assignment.

Evaluate the QUALITY OF THEIR PROMPTING STRATEGY only. You have not seen their paper. Evaluate how skillfully they collaborated with the AI, not what they produced.

=== STUDENT LLM INTERACTION LOG ===
${llmInteractions}

=== STRENGTHS to recognize ===
- Using LLM as thinking partner while retaining authorship
- Providing specific context, constraints, and rubric criteria upfront
- Stress-testing their own thesis before accepting an answer
- Asking for alternatives before recommendations
- Requesting the LLM to find weaknesses in their argument
- Iterating on substance before style

=== WEAKNESSES to flag ===
- Pasting assignment and asking for a finished answer with no context
- Not providing case facts, frameworks, or constraints
- Treating LLM as ghostwriter rather than thought partner
- Framework pile-ons without analytical focus
- Accepting unsupported statistics or vague MBA jargon
- Asking for style polish before substance is solid

=== REQUIRED OUTPUT FORMAT ===
Return ONLY valid JSON. No markdown. No text outside the JSON.

{
  "summary": "One crisp sentence (under 20 words) for professor reference capturing the key prompting insight",
  "fullCoaching": "WHAT THEY DID WELL: [specific paragraph]. CRITICAL WEAKNESSES: [specific paragraph naming the pattern]. ACTIONABLE IMPROVEMENTS: [concrete paragraph with next-session changes]. Under 300 words total."
}`;
}

// ============================================================
// buildGradingPrompt
// Deliberately has NO llmInteractions parameter.
// ============================================================
function buildGradingPrompt(
  chipContexts, priorityChipName, questions, rubricSelections,
  caseText, studentPaperText, pointsPossible,
  harshness, adjustedScores, blindGrade
) {
  const scores = adjustedScores || { absent: 0, incomplete: 0.25, partial: 0.50, strong: 0.75, mastery: 1.0 };

  let frameworkSection = '';
  chipContexts.forEach(chip => {
    const isPriority = chip.name === priorityChipName;
    frameworkSection += `\n\n=== ${isPriority ? 'PRIORITY FRAMEWORK (weight most heavily)' : 'Supporting Framework'}: ${chip.name} ===\n${chip.content}`;
  });

  let questionsSection = '';
  questions.forEach((q, i) => {
    const factors = rubricSelections[i] || [];
    questionsSection += `\nQUESTION ${i + 1}: ${q}\nRubric factors to score:\n`;
    factors.forEach(f => { questionsSection += `  - ${f}\n`; });
  });

  const blindNote = blindGrade
    ? '\nNOTE: BLIND GRADE SESSION. Grade the work only — no team identity provided.\n'
    : '';

  return `You are an expert Innovation professor grading a student group paper.
${blindNote}

=== GRADING FRAMEWORKS ===
PRIORITY framework carries the most weight.
${frameworkSection}


=== CASE STUDY TEXT ===
${caseText || '[No case text provided]'}


=== QUESTIONS AND RUBRIC FACTORS ===
${questionsSection}


=== STUDENT PAPER ===
${studentPaperText || '[No student paper provided]'}


=== GRADING SCALE (Harshness: ${harshness || 100}%) ===
Use EXACTLY these values:
  Absent:      ${scores.absent}
  Incomplete:  ${scores.incomplete}
  Partial:     ${scores.partial}
  Strong:      ${scores.strong}
  Mastery:     ${scores.mastery}


=== BEHAVIORAL ANCHORS ===
Use these exact descriptions to calibrate every score. Do not paraphrase or interpret — match the evidence to the description that fits best.

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
  ${scores.mastery}    = Clear, consistent, and value-adding contribution that improves overall team output is demonstrated.


=== TWO-PASS GRADING ===

PASS 1 — FIND EVIDENCE: For every factor in every question, locate the exact sentence or phrase in the student paper. Note it. If nothing exists, write "No evidence found." Grade only what is written.

PASS 2 — SCORE: Using only Pass 1 evidence, assign a score from the behavioral anchors above.


=== TASKS ===
1. Two-pass grade every factor for every question
2. Write a 50-word critique per question grounded in the frameworks
3. Calculate per-question and overall totals
4. Calculate percentage and finalPoints if pointsPossible = ${pointsPossible || 'not provided'}
5. Write GROUP NARRATIVE SUMMARY:
   a. SUPERPOWER: 2-3 sentences on genuine group strength
   b. IMPROVEMENTS: 1-2 sentences each on framework depth, evidence, critical thinking, alternatives
   c. WATCH FOR: one specific practical thing for future similar cases
   d. ONE-SENTENCE SUMMARY: one crisp sentence for professor memory


=== OUTPUT — CRITICAL ===
Return ONLY valid JSON. No markdown. No text outside the JSON.

{
  "questions": [
    {
      "questionNumber": 1,
      "questionText": "full question text",
      "factors": [
        {
          "factorName": "exact factor name",
          "evidence": "exact phrase from student paper, or No evidence found",
          "score": ${scores.strong},
          "justification": "one sentence tying evidence to behavioral anchor"
        }
      ],
      "questionTotal": 2.25,
      "questionMax": 3.0,
      "critique": "exactly 50 words grounded in selected frameworks"
    }
  ],
  "totalScore": 7.5,
  "totalPossible": 10.0,
  "percentage": 75.0,
  "finalPoints": "number or N/A",
  "narrativeSummary": {
    "superpower": "2-3 sentences on genuine strength",
    "improvements": "paragraph on frameworks, evidence, critical thinking, recommendations",
    "watchFor": "one specific practical thing for future cases",
    "oneSentenceSummary": "one crisp sentence for professor memory"
  }
}`;
}

// ============================================================
// saveToSheets
// ============================================================
async function saveToSheets(gradingResult, originalRequest) {
  try {
    if (!process.env.GOOGLE_SCRIPT_URL) {
      console.log('No GOOGLE_SCRIPT_URL — skipping Sheets save.');
      return;
    }
    const qPcts = Array(10).fill('');
    if (gradingResult.questions) {
      gradingResult.questions.forEach((q, i) => {
        if (i < 10) qPcts[i] = q.questionPct !== undefined ? q.questionPct + '%' : '';
      });
    }
    const payload = {
      timestamp:       new Date().toISOString(),
      year:            originalRequest.year     || '',
      section:         originalRequest.section  || '',
      caseName:        originalRequest.caseName  || '',
      team:            originalRequest.team      || '',
      q1:  qPcts[0],  q2: qPcts[1],  q3: qPcts[2],  q4: qPcts[3],  q5: qPcts[4],
      q6:  qPcts[5],  q7: qPcts[6],  q8: qPcts[7],  q9: qPcts[8],  q10: qPcts[9],
      finalPct:        gradingResult.percentage  ? gradingResult.percentage + '%' : '',
      pointsEarned:    gradingResult.finalPoints || '',
      pointsPossible:  originalRequest.pointsPossible || '',
      summary:         gradingResult.narrativeSummary?.oneSentenceSummary || '',
      promptCoaching:  gradingResult.promptCoachingSummary || '',   // one sentence only
      harshness:       originalRequest.harshness ? originalRequest.harshness + '%' : ''
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
  console.log(`Innovation Paper Grader v3 running on port ${PORT}`);
});
