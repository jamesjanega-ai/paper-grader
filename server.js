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
Calibrate every score against these descriptions.

ANALYSIS AND CRITICAL THINKING:
  ${scores.absent}     = Purely descriptive; recaps facts; no analytical lens applied
  ${scores.incomplete} = Names a framework but does not apply it to this specific case
  ${scores.partial}    = Framework applied but analysis is partial; key implications missed
  ${scores.strong}     = Framework applied correctly to case; defensible conclusions drawn
  ${scores.mastery}    = Framework used as precision lens; surfaces non-obvious insight

USE OF THEORETICAL FRAMEWORKS:
  ${scores.absent}     = No frameworks referenced
  ${scores.incomplete} = Framework name dropped without explaining its components
  ${scores.partial}    = Framework explained correctly but connection to case is generic
  ${scores.strong}     = Framework applied with specific case evidence and logic
  ${scores.mastery}    = Framework generates original insight beyond surface reading

IDENTIFICATION OF KEY ISSUES:
  ${scores.absent}     = No issues identified; paper restates narrative only
  ${scores.incomplete} = Issues mentioned but not distinguished from symptoms
  ${scores.partial}    = Primary issue identified; secondary issues conflated or missed
  ${scores.strong}     = Primary and secondary issues clearly distinguished with evidence
  ${scores.mastery}    = Issue hierarchy is insightful, non-obvious, analytically grounded

RECOMMENDATIONS:
  ${scores.absent}     = No recommendations offered
  ${scores.incomplete} = Recommendation present but vague
  ${scores.partial}    = Recommendation specific but lacks feasibility or implementation logic
  ${scores.strong}     = Recommendation specific, feasible, and tied to the analysis
  ${scores.mastery}    = Recommendation specific, prioritized, with short and long-term implications

DEVELOPMENT OF ALTERNATIVES:
  ${scores.absent}     = No alternatives presented
  ${scores.incomplete} = One alternative mentioned without evaluation
  ${scores.partial}    = Multiple alternatives listed but trade-offs not analyzed
  ${scores.strong}     = Multiple alternatives with clear pros and cons
  ${scores.mastery}    = Alternatives are distinct, evaluated, and ranked with rationale

JUSTIFICATION AND SUPPORT:
  ${scores.absent}     = Claims made with no supporting evidence
  ${scores.incomplete} = Evidence referenced but not connected to the specific claim
  ${scores.partial}    = Some claims supported; others left as assertions
  ${scores.strong}     = Most claims tied to specific case evidence or framework logic
  ${scores.mastery}    = All major claims supported; counter-evidence acknowledged

REALISM AND FEASIBILITY:
  ${scores.absent}     = Recommendations ignore practical constraints entirely
  ${scores.incomplete} = Feasibility acknowledged in passing but not analyzed
  ${scores.partial}    = Some constraints considered; gaps remain
  ${scores.strong}     = Recommendations account for key constraints with rationale
  ${scores.mastery}    = Implementation logic is specific, staged, accounts for failure modes

CREATIVITY AND ORIGINALITY:
  ${scores.absent}     = Paper restates case content or generic knowledge
  ${scores.incomplete} = Minor reframing of the obvious
  ${scores.partial}    = Some original perspective but anchored in predictable analysis
  ${scores.strong}     = Non-obvious insight present; at least one non-standard argument
  ${scores.mastery}    = Original framing that redefines the problem or solution space

ORGANIZATION AND COHERENCE:
  ${scores.absent}     = No discernible structure; ideas scattered
  ${scores.incomplete} = Some structure visible but sections do not connect logically
  ${scores.partial}    = Introduction, body, conclusion present but transitions weak
  ${scores.strong}     = Clear logical progression; each section builds on the previous
  ${scores.mastery}    = Structure itself serves the argument; nothing could be reordered

PROFESSIONAL WRITING SKILLS:
  ${scores.absent}     = Significant errors throughout that impede reading
  ${scores.incomplete} = Multiple errors that distract from reading
  ${scores.partial}    = Occasional errors but meaning is clear
  ${scores.strong}     = Clean, professional prose appropriate for graduate business writing
  ${scores.mastery}    = Precise, economical writing where word choice enhances the argument


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
