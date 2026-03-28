// ============================================================
// server.js — Innovation Paper Grader v3
//
// KEY CHANGE: Two completely separate Claude API calls.
//   Call A — GRADING:  paper + frameworks + rubric. NEVER sees LLM log.
//   Call B — COACHING: LLM interaction log only.  NEVER sees the paper.
//
// Both run in parallel. Claude cannot let prompting quality
// influence paper scores. Halo effect is architecturally impossible.
// ============================================================

const express = require('express');
const cors = require('cors');

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
// /grade — Main endpoint
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

    // Build grading prompt — LLM interactions deliberately excluded
    const gradingPrompt = buildGradingPrompt(
      chipContexts, priorityChipName, questions, rubricSelections,
      caseText, studentPaperText, pointsPossible,
      harshness, adjustedScores, blindGrade
    );

    // -------------------------------------------------------
    // Run BOTH calls in parallel.
    // Call A grades the paper.   (never sees LLM log)
    // Call B coaches on prompts. (never sees the paper)
    // -------------------------------------------------------
    const [gradingText, coachingText] = await Promise.all([
      callClaude(gradingPrompt, 10000),
      callClaudeCoaching(llmInteractions)
    ]);

    // Parse grading JSON
    const jsonMatch = gradingText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Claude grading did not return valid JSON. Raw: ' + gradingText.slice(0, 300));
    }
    const gradingResult = JSON.parse(jsonMatch[0]);

    // Inject coaching result — split into full display text and one-line sheet summary
    gradingResult.promptCoaching        = coachingText.fullCoaching;
    gradingResult.promptCoachingSummary = coachingText.summary;

    // Add per-question percentages
    if (gradingResult.questions) {
      gradingResult.questions.forEach(q => {
        q.questionPct = q.questionMax > 0
          ? parseFloat(((q.questionTotal / q.questionMax) * 100).toFixed(1))
          : 0;
      });
    }

    // Save to Sheets (non-blocking)
    saveToSheets(gradingResult, req.body).catch(err =>
      console.error('Google Sheets save failed:', err.message)
    );

    res.json({ success: true, result: gradingResult });

  } catch (err) {
    console.error('Grading failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ============================================================
// callClaude — shared helper for any Claude API call
// ============================================================
async function callClaude(prompt, maxTokens = 4000) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: maxTokens,
      temperature: 0,     // deterministic — same input always produces same output
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Claude API error: ' + (data.error?.message || 'Unknown'));
  return data.content[0].text;
}


// ============================================================
// callClaudeCoaching — ISOLATED call for LLM interaction coaching
// This call NEVER receives the student paper or case content.
// ============================================================
async function callClaudeCoaching(llmInteractions) {
  if (!llmInteractions || !llmInteractions.trim()) {
    return { summary: 'No LLM interactions provided.', fullCoaching: 'No LLM interactions provided.' };
  }
  const raw = await callClaude(buildCoachingPrompt(llmInteractions), 2000);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary:     parsed.summary     || raw.split('.')[0] + '.',
        fullCoaching: parsed.fullCoaching || raw
      };
    }
  } catch (e) {
    console.warn('Coaching JSON parse failed, falling back to raw text.');
  }
  // Fallback: use first sentence as summary, full text as coaching
  const firstSentence = raw.split(/[.!?]/)[0].trim() + '.';
  return { summary: firstSentence, fullCoaching: raw };
}


// ============================================================
// buildCoachingPrompt
// Only receives the LLM interaction log. Nothing else.
// ============================================================
function buildCoachingPrompt(llmInteractions) {
  return `You are a Prompt Engineering Coach evaluating how a student group used an AI assistant for a business case assignment.

Your job is to evaluate the QUALITY OF THEIR PROMPTING STRATEGY only. You have not seen their paper and must not comment on the quality of their analysis or conclusions. You are evaluating how skillfully they collaborated with the AI — not what they produced.

=== STUDENT LLM INTERACTION LOG ===
${llmInteractions}


=== EVALUATE THESE DIMENSIONS ===

STRENGTHS — look for:
- Using the LLM as a thinking partner while retaining their own authorship
- Providing specific context, case constraints, and rubric criteria upfront
- Stress-testing their own thesis before accepting an answer
- Asking for alternatives before recommendations
- Requesting the LLM to find weaknesses in their argument
- Building a final-pass checklist tied to actual rubric criteria
- Iterating on substance before style

WEAKNESSES — look for:
- Pasting the assignment and asking for a finished answer with no context
- Not providing case facts, frameworks, or constraints
- Rewarding confident but generic output without checking accuracy
- Treating the LLM as a ghostwriter rather than a thought partner
- Framework pile-ons (listing 8 theories without analytical focus)
- Accepting unsupported statistics or vague MBA jargon
- Asking for style polish before substance is solid
- Never checking whether the output actually fits the rubric

=== OUTPUT FORMAT — CRITICAL ===
Return ONLY a valid JSON object. No markdown. No text before or after.

{
  "summary": "One sentence (max 20 words) capturing the single most important coaching insight for professor reference",
  "fullCoaching": "Three clearly labeled paragraphs under 300 words total: (1) WHAT THEY DID WELL — specific with quotes from log. (2) CRITICAL WEAKNESSES — specific, name the pattern. (3) ACTIONABLE IMPROVEMENTS — concrete next-session changes."
}`;}



// ============================================================
// buildGradingPrompt
// Deliberately receives NO llmInteractions parameter.
// The paper is graded in complete isolation from prompting quality.
// ============================================================
function buildGradingPrompt(
  chipContexts, priorityChipName, questions, rubricSelections,
  caseText, studentPaperText, pointsPossible,
  harshness, adjustedScores, blindGrade
) {
  const scores = adjustedScores || { absent: 0, incomplete: 0.25, partial: 0.50, strong: 0.75, mastery: 1.0 };

  // Frameworks
  let frameworkSection = '';
  chipContexts.forEach(chip => {
    const isPriority = chip.name === priorityChipName;
    frameworkSection += `\n\n=== ${isPriority ? 'PRIORITY FRAMEWORK (weight most heavily)' : 'Supporting Framework'}: ${chip.name} ===\n${chip.content}`;
  });

  // Questions + factors
  let questionsSection = '';
  questions.forEach((q, i) => {
    const factors = rubricSelections[i] || [];
    questionsSection += `\nQUESTION ${i + 1}: ${q}\nRubric factors to score:\n`;
    factors.forEach(f => { questionsSection += `  - ${f}\n`; });
  });

  const blindNote = blindGrade
    ? `\nNOTE: BLIND GRADE SESSION — no team identity is provided. Grade the work alone.\n`
    : '';

  return `You are an expert Innovation professor grading a student group paper.
${blindNote}

=== GRADING FRAMEWORKS ===
PRIORITY framework carries the most weight.
${frameworkSection}


=== CASE STUDY TEXT ===
${caseText || '[No case text provided — grade based on student paper only]'}


=== QUESTIONS AND RUBRIC FACTORS ===
Grade ONLY the listed factors per question.
${questionsSection}


=== STUDENT PAPER ===
${studentPaperText || '[No student paper provided]'}


=== GRADING SCALE (Harshness: ${harshness || 100}%) ===
Assign EXACTLY ONE of these values per factor:
  Absent:      ${scores.absent}
  Incomplete:  ${scores.incomplete}
  Partial:     ${scores.partial}
  Strong:      ${scores.strong}
  Mastery:     ${scores.mastery}


=== BEHAVIORAL ANCHORS ===
Use these to calibrate scores precisely. These define what each level looks like.

ANALYSIS AND CRITICAL THINKING:
  ${scores.absent}     = Purely descriptive; recaps case facts; no analytical lens applied
  ${scores.incomplete} = Names a framework but does not apply it to this specific case
  ${scores.partial}    = Framework applied but analysis is partial; key implications missed
  ${scores.strong}     = Framework applied correctly to case; defensible conclusions drawn
  ${scores.mastery}    = Framework used as a precise lens; surfaces non-obvious insight

USE OF THEORETICAL FRAMEWORKS:
  ${scores.absent}     = No frameworks referenced anywhere
  ${scores.incomplete} = Framework name dropped without explaining its components
  ${scores.partial}    = Framework explained correctly but connection to case is generic
  ${scores.strong}     = Framework applied with specific case evidence and clear logic
  ${scores.mastery}    = Framework generates original insight beyond surface reading

IDENTIFICATION OF KEY ISSUES:
  ${scores.absent}     = No issues identified; paper restates narrative only
  ${scores.incomplete} = Issues mentioned but not distinguished from symptoms
  ${scores.partial}    = Primary issue identified; secondary issues conflated or missed
  ${scores.strong}     = Primary and secondary issues clearly distinguished with evidence
  ${scores.mastery}    = Issue hierarchy is insightful, non-obvious, analytically grounded

RECOMMENDATIONS:
  ${scores.absent}     = No recommendations offered
  ${scores.incomplete} = Recommendation present but vague (e.g. "focus more on customers")
  ${scores.partial}    = Recommendation specific but lacks feasibility or implementation logic
  ${scores.strong}     = Recommendation specific, feasible, and tied directly to the analysis
  ${scores.mastery}    = Recommendation specific, prioritized, with short and long-term implications

DEVELOPMENT OF ALTERNATIVES:
  ${scores.absent}     = No alternatives presented
  ${scores.incomplete} = One alternative mentioned without evaluation
  ${scores.partial}    = Two or more alternatives listed but trade-offs not analyzed
  ${scores.strong}     = Multiple alternatives with clear pros and cons per option
  ${scores.mastery}    = Alternatives are distinct, evaluated, and ranked with explicit rationale

JUSTIFICATION AND SUPPORT:
  ${scores.absent}     = Claims made without any supporting evidence
  ${scores.incomplete} = Evidence referenced but not connected to the specific claim
  ${scores.partial}    = Some claims supported; others left as unsupported assertions
  ${scores.strong}     = Most claims tied to specific case evidence or framework logic
  ${scores.mastery}    = All major claims supported; counter-evidence acknowledged

REALISM AND FEASIBILITY:
  ${scores.absent}     = Recommendations ignore practical constraints entirely
  ${scores.incomplete} = Feasibility acknowledged in passing but not analyzed
  ${scores.partial}    = Some constraints considered; gaps remain in logic
  ${scores.strong}     = Recommendations account for key constraints with clear rationale
  ${scores.mastery}    = Implementation logic is specific, staged, accounts for failure modes

CREATIVITY AND ORIGINALITY:
  ${scores.absent}     = Paper restates case content or generic industry knowledge
  ${scores.incomplete} = Minor reframing of the obvious
  ${scores.partial}    = Some original perspective but anchored in predictable analysis
  ${scores.strong}     = Non-obvious insight present; at least one argument is not standard
  ${scores.mastery}    = Original framing that redefines the problem or solution space

ORGANIZATION AND COHERENCE:
  ${scores.absent}     = No discernible structure; ideas scattered
  ${scores.incomplete} = Some structure visible but sections do not connect logically
  ${scores.partial}    = Introduction, body, and conclusion present but transitions weak
  ${scores.strong}     = Clear logical progression; each section builds on the previous
  ${scores.mastery}    = Structure itself serves the argument; nothing could be reordered

PROFESSIONAL WRITING SKILLS:
  ${scores.absent}     = Significant grammar, spelling, or punctuation errors throughout
  ${scores.incomplete} = Multiple errors that distract from reading
  ${scores.partial}    = Occasional errors but meaning is clear
  ${scores.strong}     = Clean, professional prose appropriate for graduate business writing
  ${scores.mastery}    = Precise, economical writing where word choice consistently enhances the argument


=== TWO-PASS GRADING PROCESS ===

PASS 1 — FIND THE EVIDENCE:
For every factor in every question, locate the specific sentence, phrase, or argument in the student paper that constitutes evidence for that factor. If nothing exists, note "No evidence found." Do not infer from what the student probably meant. Grade only what is written.

PASS 2 — SCORE THE EVIDENCE:
Using only what you found in Pass 1, assign a score using the behavioral anchors above. A paper that mentions a concept without applying it = ${scores.incomplete}. Correct application with case specifics = ${scores.strong}. Mastery = ${scores.mastery} and requires non-obvious insight.


=== YOUR TASKS ===
1. Pass 1 + Pass 2 for every factor in every question
2. 50-word critique per question grounded in the frameworks
3. Calculate per-question totals and overall total
4. Calculate percentage and finalPoints if pointsPossible = ${pointsPossible || 'not provided'}
5. Write the GROUP NARRATIVE SUMMARY:
   a. SUPERPOWER: 2-3 sentences on what the group genuinely did well
   b. IMPROVEMENTS: 1-2 sentences each on: framework depth, evidence, critical thinking, alternatives/recommendations
   c. WATCH FOR: one specific practical thing for future similar cases
   d. ONE-SENTENCE SUMMARY: one crisp sentence for professor memory


=== OUTPUT — CRITICAL ===
Return ONLY valid JSON. No markdown. No explanation. No text outside the JSON.

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
          "justification": "one sentence tying evidence to score using behavioral anchor"
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
      timestamp:        new Date().toISOString(),
      year:             originalRequest.year || '',
      section:          originalRequest.section || '',
      caseName:         originalRequest.caseName || '',
      team:             originalRequest.team || '',
      q1:  qPcts[0],   q2:  qPcts[1],  q3:  qPcts[2],  q4:  qPcts[3],  q5:  qPcts[4],
      q6:  qPcts[5],   q7:  qPcts[6],  q8:  qPcts[7],  q9:  qPcts[8],  q10: qPcts[9],
      finalPct:         gradingResult.percentage ? gradingResult.percentage + '%' : '',
      pointsEarned:     gradingResult.finalPoints || '',
      pointsPossible:   originalRequest.pointsPossible || '',
      summary:          gradingResult.narrativeSummary?.oneSentenceSummary || '',
      promptCoaching:   gradingResult.promptCoachingSummary || '',  // one sentence only
      harshness:        originalRequest.harshness ? originalRequest.harshness + '%' : ''
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
