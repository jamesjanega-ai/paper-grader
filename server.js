// ============================================================
// server.js — Innovation Paper Grader Backend v2
// ============================================================

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public')); // Serves grader app from /public/index.html


// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.send('Innovation Paper Grader v2 is running.');
});


// ============================================================
// /grade — Main grading endpoint
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
      adjustedScores
    } = req.body;

    const prompt = buildGradingPrompt(
      chipContexts, priorityChipName, questions, rubricSelections,
      caseText, studentPaperText, llmInteractions, pointsPossible,
      harshness, adjustedScores
    );

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 10000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeResponse.json();

    if (!claudeResponse.ok) {
      throw new Error('Claude API error: ' + (claudeData.error?.message || 'Unknown'));
    }

    const responseText = claudeData.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Claude did not return valid JSON. Raw: ' + responseText.slice(0, 300));
    }

    const gradingResult = JSON.parse(jsonMatch[0]);

    // Add per-question percentages
    if (gradingResult.questions) {
      gradingResult.questions.forEach(q => {
        q.questionPct = q.questionMax > 0
          ? parseFloat(((q.questionTotal / q.questionMax) * 100).toFixed(1))
          : 0;
      });
    }

    // Log to Google Sheets (non-blocking)
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
// buildGradingPrompt
// ============================================================
function buildGradingPrompt(
  chipContexts, priorityChipName, questions, rubricSelections,
  caseText, studentPaperText, llmInteractions, pointsPossible,
  harshness, adjustedScores
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
    questionsSection += `\nQUESTION ${i + 1}: ${q}\nApplicable rubric factors:\n`;
    factors.forEach(f => { questionsSection += `  - ${f}\n`; });
  });

  const coachingInstruction = llmInteractions
    ? `\nAlso review the student LLM interaction log. Act as a Prompt Engineering Coach: identify (1) what they did well, (2) specific weaknesses in their prompting strategy, (3) concrete actionable improvements.`
    : '';

  return `You are an expert Innovation professor grading a student group paper.

=== GRADING FRAMEWORKS ===
Use these frameworks to evaluate the quality of student thinking.
The PRIORITY framework carries the most weight in your assessment.
${frameworkSection}


=== CASE STUDY TEXT ===
${caseText || '[No case text provided - grade based on student paper only]'}


=== QUESTIONS AND THEIR RUBRIC FACTORS ===
Grade ONLY the factors listed for each question. Do not add factors not listed.
${questionsSection}


=== STUDENT PAPER ===
${studentPaperText || '[No student paper provided]'}


=== GRADING SCALE (Harshness: ${harshness || 100}%) ===
For each factor, assign EXACTLY ONE of these score values:
- Completely absent from response:          ${scores.absent}
- Mentioned but incomplete understanding:   ${scores.incomplete}
- Partial understanding demonstrated:       ${scores.partial}
- Strong understanding shown:               ${scores.strong}
- Mastery of concept clearly demonstrated:  ${scores.mastery}

Use ONLY these exact numeric values. Do not round or substitute other values.


=== YOUR TASKS ===
1. Score every factor for every question using the scale above
2. Write a focused 50-word critique per question grounded in the selected frameworks
3. Calculate totals: per-question and overall
4. Calculate percentage (totalScore / totalPossible * 100)
5. If pointsPossible was provided (${pointsPossible || 'not provided'}), calculate finalPoints = percentage * pointsPossible / 100
6. Write a GROUP NARRATIVE SUMMARY with four parts:
   a. SUPERPOWER: 2-3 sentences on what the group did genuinely well - their insight strength
   b. IMPROVEMENTS: For each dimension below, 1-2 sentences on where they should go deeper:
      - Theoretical frameworks from class
      - Connection to evidence and data
      - Critical thinking and analysis
      - Development of alternatives and recommendations
   c. WATCH FOR: ONE specific, practical, memorable thing to watch for if they encounter a similar case in real life - tied to their actual work in this paper
   d. ONE-SENTENCE SUMMARY: A single crisp sentence the professor can read months later to remember this grading session
${coachingInstruction}

${llmInteractions ? `\n=== STUDENT LLM INTERACTIONS ===\n${llmInteractions}` : ''}


=== OUTPUT FORMAT - CRITICAL ===
Return ONLY a single valid JSON object. No markdown. No explanation. No text before or after the JSON.

{
  "questions": [
    {
      "questionNumber": 1,
      "questionText": "full question text",
      "factors": [
        {
          "factorName": "exact factor name as listed",
          "score": ${scores.strong},
          "justification": "one sentence explaining this specific score"
        }
      ],
      "questionTotal": 2.25,
      "questionMax": 3.0,
      "critique": "exactly 50 words critiquing this answer using the selected frameworks"
    }
  ],
  "totalScore": 7.5,
  "totalPossible": 10.0,
  "percentage": 75.0,
  "finalPoints": "calculated number or N/A",
  "promptCoaching": "coaching feedback on student LLM usage, or No LLM interactions provided",
  "narrativeSummary": {
    "superpower": "2-3 sentences on what the group did really well - their insight superpower",
    "improvements": "Paragraph covering frameworks depth, evidence connection, critical thinking, and recommendations quality",
    "watchFor": "One specific practical memorable thing to watch for in future similar cases",
    "oneSentenceSummary": "One crisp sentence for the professor to jog their memory"
  }
}`;
}


// ============================================================
// saveToSheets — via Google Apps Script Web App
//
// Sheet columns:
// A: Timestamp       B: Year            C: Section
// D: Case            E: Team            F-O: Q1%–Q10%
// P: Final%          Q: Points Earned   R: Points Possible
// S: Summary         T: Prompt Coaching U: Harshness %
// ============================================================
async function saveToSheets(gradingResult, originalRequest) {
  try {
    if (!process.env.GOOGLE_SCRIPT_URL) {
      console.log('No GOOGLE_SCRIPT_URL set - skipping Sheets save.');
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
      promptCoaching:   gradingResult.promptCoaching || '',
      harshness:        originalRequest.harshness ? originalRequest.harshness + '%' : ''
    };

    const response = await fetch(process.env.GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (result.success) {
      console.log('Saved to Google Sheets successfully.');
    } else {
      console.error('Apps Script error:', result.error);
    }
  } catch (err) {
    console.error('Google Sheets save error:', err.message);
  }
}


// ============================================================
// Start server
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Innovation Paper Grader v2 running on port ${PORT}`);
});
