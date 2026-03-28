// ============================================================
// server.js — Innovation Paper Grader Backend
// Receives grading inputs from grader.html, calls Claude API,
// and logs results to Google Sheets.
// ============================================================

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Papers can be long


// ============================================================
// HEALTH CHECK — Render uses this to confirm the app is alive
// Visit your Render URL in a browser to test this
// ============================================================
app.get('/', (req, res) => {
  res.send('Innovation Paper Grader is running.');
});


// ============================================================
// /grade — Main grading endpoint
// Called by grader.html when professor clicks "Grade Paper"
// ============================================================
app.post('/grade', async (req, res) => {
  try {
    const {
      chipContexts,       // Array of { name, content } — the selected GPT frameworks
      priorityChipName,   // Name of the chip marked as most important
      questions,          // Array of question strings
      rubricSelections,   // Object: { 0: ['Factor A', 'Factor B'], 1: [...] }
      caseText,           // Text extracted from the dropped case PDF
      studentPaperText,   // Student paper text (PDF or pasted)
      llmInteractions,    // Student LLM conversation log (optional)
      pointsPossible      // Total assignment points entered by professor
    } = req.body;

    // Build the full Claude prompt from all inputs
    const prompt = buildGradingPrompt(
      chipContexts,
      priorityChipName,
      questions,
      rubricSelections,
      caseText,
      studentPaperText,
      llmInteractions,
      pointsPossible
    );

    // Call Claude API
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeResponse.json();

    // If Claude returned an error, surface it clearly
    if (!claudeResponse.ok) {
      throw new Error('Claude API error: ' + (claudeData.error?.message || 'Unknown error'));
    }

    const responseText = claudeData.content[0].text;

    // Extract the JSON block from Claude's response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Claude did not return valid JSON. Raw: ' + responseText.slice(0, 300));
    }

    const gradingResult = JSON.parse(jsonMatch[0]);

    // Save to Google Sheets in the background (won't slow down the response)
    saveToSheets(gradingResult, req.body).catch(err =>
      console.error('Google Sheets save failed:', err.message)
    );

    // Send the grading result back to the browser
    res.json({ success: true, result: gradingResult });

  } catch (err) {
    console.error('Grading failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ============================================================
// buildGradingPrompt
// Assembles all professor inputs into one structured prompt
// ============================================================
function buildGradingPrompt(
  chipContexts,
  priorityChipName,
  questions,
  rubricSelections,
  caseText,
  studentPaperText,
  llmInteractions,
  pointsPossible
) {

  // --- Build the frameworks section ---
  let frameworkSection = '';
  chipContexts.forEach(chip => {
    if (chip.name === priorityChipName) {
      frameworkSection += `\n\n=== PRIORITY FRAMEWORK (weight this most heavily): ${chip.name} ===\n${chip.content}`;
    } else {
      frameworkSection += `\n\n=== Supporting Framework: ${chip.name} ===\n${chip.content}`;
    }
  });

  // --- Build the questions + rubric factors section ---
  let questionsSection = '';
  questions.forEach((q, i) => {
    const factors = rubricSelections[i] || [];
    questionsSection += `\nQUESTION ${i + 1}: ${q}\nApplicable rubric factors for this question:\n`;
    factors.forEach(f => {
      questionsSection += `  - ${f}\n`;
    });
  });

  // --- Add prompt coaching instruction if LLM log was provided ---
  const promptCoachingInstruction = llmInteractions
    ? `\nAlso review the student LLM interaction log at the end. Act as a Prompt Engineering Coach. Identify: (1) what they did well, (2) specific weaknesses in their prompting strategy, (3) concrete, actionable improvements.`
    : '';

  // --- Assemble the full prompt ---
  return `You are an expert Innovation professor grading a student group paper.

=== YOUR GRADING FRAMEWORKS ===
Use these to evaluate the quality of student thinking.
The PRIORITY framework carries the most weight in your assessment.
${frameworkSection}


=== CASE STUDY TEXT ===
${caseText || '[No case text was provided — grade based on student paper only]'}


=== QUESTIONS AND THEIR RUBRIC FACTORS ===
Grade ONLY the factors listed for each question.
Do not introduce factors that are not listed.
${questionsSection}


=== STUDENT PAPER ===
${studentPaperText || '[No student paper was provided]'}


=== GRADING SCALE ===
For each applicable factor, assign exactly ONE of these scores:
0    = Factor is completely absent from the response
0.25 = Factor is mentioned but shows incomplete understanding
0.5  = Partial understanding of the factor is shown
0.75 = Strong understanding of the factor is shown
1    = Mastery of the concept is clearly demonstrated


=== YOUR TASKS ===
1. Score every factor listed for every question using the scale above
2. Write a 50-word critique per question grounded in the selected frameworks
3. Calculate totals: per-question and overall
4. Calculate percentage (totalScore / totalPossible * 100)
5. If pointsPossible was provided (${pointsPossible || 'not provided'}), calculate finalPoints = percentage * pointsPossible / 100
${promptCoachingInstruction}

${llmInteractions ? `\n=== STUDENT LLM INTERACTIONS ===\n${llmInteractions}` : ''}


=== OUTPUT FORMAT — CRITICAL ===
Return ONLY a single valid JSON object.
No markdown. No explanation. No text before or after.
Follow this exact structure:

{
  "questions": [
    {
      "questionNumber": 1,
      "questionText": "the full question text here",
      "factors": [
        {
          "factorName": "exact factor name as listed",
          "score": 0.75,
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
  "finalPoints": "calculated number or N/A if no point total was entered",
  "promptCoaching": "coaching feedback on the student LLM usage, or 'No LLM interactions provided'"
}`;
}


// ============================================================
// saveToSheets
// Logs each grading session to Google Sheets for trend analysis
// ============================================================
async function saveToSheets(gradingResult, originalRequest) {
  try {
    const auth = new GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // One summary row per grading session
    const row = [
      new Date().toISOString(),                                              // A: Timestamp
      originalRequest.priorityChipName || '',                               // B: Priority framework
      (originalRequest.chipContexts || []).map(c => c.name).join(', '),    // C: All chips used
      originalRequest.questions?.length || 0,                               // D: Number of questions
      gradingResult.totalScore,                                             // E: Raw score earned
      gradingResult.totalPossible,                                          // F: Max score possible
      gradingResult.percentage,                                             // G: Percentage
      gradingResult.finalPoints || 'N/A',                                   // H: Final points
      originalRequest.pointsPossible || 'N/A'                               // I: Points possible entered
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:I',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] }
    });

    console.log('Grading session saved to Google Sheets.');

  } catch (err) {
    // Log the error but don't crash the app
    console.error('Google Sheets error:', err.message);
  }
}


// ============================================================
// Start the server
// Render will set PORT automatically — 3000 is our local fallback
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Innovation Paper Grader running on port ${PORT}`);
});
