/**
 * FightLab AI Backend Server
 *
 * This server handles:
 * 1. Receiving video frames from the iOS app
 * 2. Sending frames directly to Claude AI (as base64)
 * 3. Returning structured analysis matching the iOS app's data models
 *
 * SIMPLIFIED: We send frames directly to Claude as base64 instead of using R2 URLs.
 * This is more reliable and avoids public access issues with R2.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

// ============================================
// CONFIGURATION
// ============================================

const app = express();
const PORT = process.env.PORT || 3000;

// Multer setup for handling file uploads (stores in memory temporarily)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max per frame
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ============================================
// CLAUDE AI SETUP
// ============================================

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ============================================
// IN-MEMORY STORAGE (Replace with database later)
// ============================================

const analysisStore = new Map(); // Stores analysis results by ID

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Build the Claude prompt with EXACT JSON schema matching iOS models
 * This is CRITICAL - the JSON structure must match AnalysisReport.swift exactly
 */
function buildClaudePrompt(config) {
  const fighterName = config.fighter1Name || 'the fighter';
  const userRounds = config.userFightRounds || 3;
  const videoRounds = config.videoRounds || 3;
  const sessionType = config.sessionType || 'competition';

  // Extract appearance data (new structured format or legacy string)
  const fighter1Appearance = config.fighter1Appearance || {};
  const fighter2Appearance = config.fighter2Appearance || {};

  // Get shorts color - prefer structured, fall back to legacy description parsing
  const shortsColor = fighter1Appearance.shortsColor ||
    config.fighter1Description?.match(/(\w+)\s*shorts/i)?.[1] || '';
  const fighter2ShortsColor = fighter2Appearance.shortsColor ||
    config.fighter2Description?.match(/(\w+)\s*shorts/i)?.[1] || '';

  // Build appearance description from structured data
  function buildAppearanceString(appearance, description) {
    if (!appearance || Object.keys(appearance).length === 0) {
      return description || '';
    }
    const parts = [];
    if (appearance.shortsColor) parts.push(`${appearance.shortsColor} shorts`);
    if (appearance.skinTone) parts.push(`${appearance.skinTone} skin tone`);
    if (appearance.bodyBuild) parts.push(`${appearance.bodyBuild} build`);
    if (appearance.relativeHeight) parts.push(appearance.relativeHeight);
    if (appearance.distinguishingFeatures?.length > 0) {
      parts.push(appearance.distinguishingFeatures.join(', '));
    }
    if (appearance.customDescription) parts.push(appearance.customDescription);
    return parts.length > 0 ? parts.join(', ') : (description || '');
  }

  const fighter1AppearanceStr = buildAppearanceString(fighter1Appearance, config.fighter1Description);
  const fighter2AppearanceStr = buildAppearanceString(fighter2Appearance, config.fighter2Description);

  // Get declared backgrounds
  const fighter1Background = config.fighter1DeclaredBackground || null;
  const fighter2Background = config.fighter2DeclaredBackground || null;

  // Build fighter context with STRONG visual emphasis
  let fighterContext = '';

  if (config.analysisType === 'both') {
    fighterContext = `
ANALYZING: Both Fighters

FIGHTER A: ${config.fighter1Name || 'Fighter 1'} (${config.fighter1Corner || 'Unknown'} Corner)
${shortsColor ? `🎯 SHORTS COLOR: ${shortsColor.toUpperCase()} - PRIMARY IDENTIFIER` : ''}
${fighter1AppearanceStr ? `APPEARANCE: ${fighter1AppearanceStr}` : ''}
${fighter1Background ? `DECLARED BACKGROUND: ${fighter1Background} (user-provided, may differ from observed style)` : ''}

FIGHTER B: ${config.fighter2Name || 'Fighter 2'} (${config.fighter2Corner || 'Unknown'} Corner)
${fighter2ShortsColor ? `🎯 SHORTS COLOR: ${fighter2ShortsColor.toUpperCase()} - PRIMARY IDENTIFIER` : ''}
${fighter2AppearanceStr ? `APPEARANCE: ${fighter2AppearanceStr}` : ''}
${fighter2Background ? `DECLARED BACKGROUND: ${fighter2Background} (user-provided, may differ from observed style)` : ''}`;
  } else {
    fighterContext = `
═══════════════════════════════════════════════════════════
🎯 TARGET FIGHTER IDENTIFICATION (CRITICAL)
═══════════════════════════════════════════════════════════
NAME: ${fighterName}
CORNER: ${config.fighter1Corner || 'Unknown'} Corner
${shortsColor ? `🎯 SHORTS COLOR: ${shortsColor.toUpperCase()} - USE THIS TO IDENTIFY THE FIGHTER` : ''}
${fighter1AppearanceStr ? `PHYSICAL DESCRIPTION: ${fighter1AppearanceStr}` : ''}
${fighter1Background ? `DECLARED BACKGROUND: ${fighter1Background} (user-provided - verify against observed behavior)` : ''}

⚠️ CRITICAL: You MUST identify "${fighterName}" using the visual markers above.
⚠️ Look for the fighter wearing ${shortsColor ? shortsColor.toUpperCase() + ' shorts' : 'the described attire'} in the ${config.fighter1Corner || ''} corner.
⚠️ The OTHER fighter in the video is the OPPONENT - do NOT analyze their skills as if they belong to ${fighterName}.
${fighter1Background ? `⚠️ User says "${fighterName}" has a ${fighter1Background} background - VERIFY this matches what you observe. Report if different.` : ''}`;
  }

  const roleContext = {
    'fighter': 'Fighter preparing to face this opponent',
    'coach': 'Coach analyzing for their student/fighter',
    'study': 'General study and analysis purposes'
  }[config.userRole] || 'General analysis';

  return `You are an expert MMA fight analyst. Analyze the provided fight video frames and generate a comprehensive tactical analysis.

═══════════════════════════════════════════════════════════
🚨 CRITICAL INSTRUCTION - FIGHTER IDENTIFICATION 🚨
═══════════════════════════════════════════════════════════

**STEP 1 - IDENTIFY THE TARGET FIGHTER FIRST:**
Before analyzing ANYTHING, you MUST identify which person in the video is the target fighter.
Use these visual identifiers in order of reliability:
1. SHORTS COLOR - Most reliable identifier
2. CORNER POSITION - Which corner they came from
3. PHYSICAL DESCRIPTION - Body type, tattoos, appearance

${fighterContext}

═══════════════════════════════════════════════════════════
🚨 CRITICAL - ANALYZE ONLY THE TARGET FIGHTER 🚨
═══════════════════════════════════════════════════════════

**WHAT TO ANALYZE (TARGET FIGHTER'S ACTIONS):**
- Strikes that ${fighterName} THROWS (their offense)
- Takedowns that ${fighterName} INITIATES (their wrestling offense)
- Ground control when ${fighterName} IS ON TOP
- Submissions that ${fighterName} ATTEMPTS
- Movement and footwork of ${fighterName}
- Defense when ${fighterName} blocks/evades (their defensive skills)

**WHAT NOT TO ANALYZE AS THE TARGET'S SKILLS:**
- Takedowns AGAINST ${fighterName} = OPPONENT's skill, NOT ${fighterName}'s
- Ground control when ${fighterName} IS ON BOTTOM = OPPONENT's skill
- Strikes that HIT ${fighterName} = OPPONENT's skill

**EXAMPLE:**
If ${fighterName} (wearing ${shortsColor || 'identified'} shorts) is getting taken down and controlled by the opponent:
- This shows ${fighterName}'s WEAKNESS in takedown defense
- This does NOT mean ${fighterName} is a "wrestler"
- The OPPONENT is the wrestler in this case

═══════════════════════════════════════════════════════════
VIDEO-ONLY ANALYSIS
═══════════════════════════════════════════════════════════

**IMPORTANT**: Base your ENTIRE analysis ONLY on what you observe in these video frames.
- Do NOT use any prior knowledge about the fighter's name or reputation
- Do NOT assume anything based on who the fighter is
- ONLY analyze what you can actually SEE the TARGET FIGHTER doing
- If ${fighterName} primarily shoots takedowns and controls → they are a WRESTLER/GRAPPLER
- If ${fighterName} primarily throws punches and kicks → they are a STRIKER
- If ${fighterName} IS BEING taken down and controlled → they may have WEAK wrestling (check their offense)

VIDEO: ${videoRounds} rounds of ${sessionType}
USER'S UPCOMING FIGHT: ${userRounds} rounds
USER CONTEXT: ${roleContext}

═══════════════════════════════════════════════════════════
CRITICAL: JSON OUTPUT FORMAT
═══════════════════════════════════════════════════════════

You MUST respond with ONLY valid JSON matching this EXACT structure.
Use camelCase for all field names. All scores are 0-100 unless noted.

{
  "fighterIdentification": {
    "confirmedName": "<string: the fighter name you are analyzing - should match '${fighterName}'>",
    "visualIdentifiers": "<string: how you identified them - e.g., 'Fighter wearing yellow shorts in blue corner'>",
    "confidenceLevel": "<string: 'High', 'Medium', or 'Low' - how confident you are this is the correct fighter>",
    "observedStyle": "<string: the fighting style you OBSERVED in the video - e.g., 'Striking-Heavy', 'Wrestling-Heavy', 'Mixed', 'BJJ-Focused'>",
    "declaredBackground": "${fighter1Background || 'Not specified'}",
    "styleMismatch": <boolean: true if observedStyle differs significantly from declaredBackground, false otherwise>
  },

  "executiveSummary": {
    "overallScore": <number 0-100 - THIS IS THE THREAT LEVEL: How dangerous/skilled this fighter appears based on the video. 90+ = Elite level, 80-89 = Very skilled, 70-79 = Skilled, 60-69 = Average, Below 60 = Developing>,
    "summary": "<string: 2-3 sentence overview of what you OBSERVED in the video>",
    "keyFindings": ["<string: specific observation from video>", "<string>", "<string>", "<string>"],
    "recommendedApproach": "<string: overall strategy recommendation based on observed weaknesses>"
  },

  "fightingStyleBreakdown": {
    "primaryStyle": "<string: BASED ON WHAT YOU SEE IN VIDEO - e.g., 'Wrestler' if they shoot takedowns, 'Pressure Boxer' if they throw punches, 'Grappler' if they work on the ground>",
    "stance": "<string: 'Orthodox' or 'Southpaw' - observe their lead hand/foot>",
    "secondarySkills": ["<string: secondary skill OBSERVED>", "<string>"],
    "baseMartialArts": ["<string: martial arts DEMONSTRATED in video - e.g., 'Wrestling', 'Boxing', 'BJJ', 'Muay Thai'>"],
    "styleDescription": "<string: detailed description of what you OBSERVED them doing most in the video>",
    "secondaryAttributes": ["<string: attribute like 'Elite Cardio', 'Knockout Power', 'Submission Threat' based on VIDEO>", "<string>", "<string>"],
    "comparableFighters": ["<string: famous fighter with SIMILAR STYLE to what you observed - must match their actual fighting style>", "<string>", "<string>"],
    "tacticalTendencies": ["<string: specific tactical pattern OBSERVED in video>", "<string>", "<string>", "<string>"]
  },

  "strikeAnalysis": {
    "accuracy": <number 0-100>,
    "volume": <integer: total strikes>,
    "powerScore": <number 0-100>,
    "techniqueScore": <number 0-100>,
    "breakdown": {
      "jabs": <integer>,
      "crosses": <integer>,
      "hooks": <integer>,
      "uppercuts": <integer>,
      "kicks": <integer>,
      "knees": <integer>,
      "elbows": <integer>
    },
    "patterns": ["<string: observed striking pattern>"],
    "recommendations": ["<string: improvement suggestion>"]
  },

  "grapplingAnalysis": {
    "takedownAccuracy": <number 0-100>,
    "takedownDefense": <number 0-100>,
    "controlTime": <number: seconds of control time>,
    "submissionAttempts": <integer>,
    "techniques": ["<string: observed grappling technique>"],
    "recommendations": ["<string: improvement suggestion>"]
  },

  "defenseAnalysis": {
    "headMovement": <number 0-100>,
    "footwork": <number 0-100>,
    "blockingRate": <number 0-100>,
    "counterStrikeRate": <number 0-100>,
    "vulnerabilities": ["<string: defensive weakness>"],
    "improvements": ["<string: how to improve>"]
  },

  "cardioAnalysis": {
    "roundByRound": [
      {
        "roundNumber": <integer>,
        "outputLevel": <number 0-100>,
        "staminaScore": <number 0-100>,
        "notes": "<string: observation about this round>"
      }
    ],
    "overallStamina": <number 0-100>,
    "fatigueIndicators": ["<string: sign of fatigue>"],
    "recommendations": ["<string: conditioning recommendation>"]
  },

  "fightIQ": {
    "overallScore": <number 0-100>,
    "decisionMaking": <number 0-100>,
    "adaptability": <number 0-100>,
    "strategyExecution": <number 0-100>,
    "keyObservations": ["<string: observation about fight IQ>"],
    "improvements": ["<string: how to improve>"]
  },

  "strengthsWeaknesses": {
    "strengths": [
      {
        "title": "<string: strength name>",
        "description": "<string: detailed description>",
        "score": <number 0-100>,
        "statistics": "<string or null: relevant stat>"
      }
    ],
    "weaknesses": [
      {
        "title": "<string: weakness name>",
        "description": "<string: detailed description>",
        "severity": <number 0-100>,
        "exploitablePattern": "<string: how opponent exploits this>",
        "frequency": "<string or null: how often it occurs>",
        "exploitationStrategy": "<string: specific way to exploit>"
      }
    ],
    "opportunitiesToExploit": ["<string: opportunity>"]
  },

  "mistakePatterns": {
    "patterns": [
      {
        "pattern": "<string: description of repeated mistake>",
        "frequency": <integer: times observed>,
        "severity": "<string: 'high', 'medium', or 'low'>"
      }
    ]
  },

  "counterStrategy": {
    "bestCounter": {
      "style": "<string: recommended fighting style to use>",
      "reason": "<string: why this works>"
    },
    "secondBestCounter": {
      "style": "<string>",
      "reason": "<string>"
    },
    "thirdBestCounter": {
      "style": "<string>",
      "reason": "<string>"
    },
    "techniquesToEmphasize": ["<string: specific technique>"]
  },

  "gamePlan": {
    "overallStrategy": "<string: overall fight strategy>",
    "roundByRound": [
      {
        "roundNumber": <integer: 1 to ${userRounds}>,
        "objective": "<string: round objective>",
        "tactics": ["<string: specific tactic>"],
        "keyFocus": "<string: main focus for round>"
      }
    ],
    "roundGamePlans": [
      {
        "roundNumber": <integer: 1 to ${userRounds}>,
        "title": "<string: round title>",
        "planA": {
          "name": "<string: plan name>",
          "goal": "<string: what to achieve>",
          "tactics": ["<string>"],
          "successIndicators": ["<string: sign plan is working>"],
          "switchTrigger": "<string or null: when to switch plans>"
        },
        "planB": {
          "name": "<string>",
          "goal": "<string>",
          "tactics": ["<string>"],
          "successIndicators": ["<string>"],
          "switchTrigger": "<string or null>"
        },
        "planC": {
          "name": "<string>",
          "goal": "<string>",
          "tactics": ["<string>"],
          "successIndicators": ["<string>"],
          "switchTrigger": null
        }
      }
    ],
    "keyTactics": ["<string: key tactic>"],
    "thingsToAvoid": ["<string: what NOT to do>"]
  },

  "midFightAdjustments": {
    "adjustments": [
      {
        "ifCondition": "<string: if this happens...>",
        "thenAction": "<string: then do this...>"
      }
    ]
  },

  "trainingRecommendations": {
    "priorityDrills": ["<string: specific drill>"],
    "sparringFocus": ["<string: sparring focus area>"],
    "conditioning": ["<string: conditioning recommendation>"]
  },

  "keyInsights": {
    "criticalObservations": ["<string: critical observation>"],
    "winConditions": ["<string: how to win>"],
    "riskFactors": ["<string: potential risk>"],
    "finalRecommendation": "<string: final advice>",
    "confidenceLevel": "<string: 'High', 'Medium', or 'Low'>"
  },

  "roundByRoundMetrics": {
    "rounds": [
      {
        "roundNumber": <integer>,
        "outputLevel": <number 0-100>,
        "notes": "<string or null: round observation>",
        "striking": {
          "strikesLanded": <integer>,
          "strikesAttempted": <integer>,
          "accuracy": <number 0-100>,
          "significantStrikes": <integer>,
          "powerStrikes": <integer>,
          "headStrikes": <integer>,
          "bodyStrikes": <integer>,
          "legStrikes": <integer>,
          "knockdowns": <integer>
        },
        "grappling": {
          "takedownsLanded": <integer>,
          "takedownsAttempted": <integer>,
          "takedownAccuracy": <number 0-100>,
          "takedownsDefended": <integer>,
          "takedownDefenseRate": <number 0-100>,
          "controlTimeSeconds": <integer>,
          "submissionAttempts": <integer>,
          "reversals": <integer>
        },
        "defense": {
          "strikesAbsorbed": <integer>,
          "strikesAvoided": <number 0-100>,
          "headMovementSuccess": <number 0-100>,
          "takedownsDefended": <integer>,
          "escapes": <integer>
        }
      }
    ]
  }
}

═══════════════════════════════════════════════════════════
REQUIREMENTS
═══════════════════════════════════════════════════════════

1. GAME PLANS: Create EXACTLY ${userRounds} roundByRound entries and ${userRounds} roundGamePlans entries (for rounds 1-${userRounds})
2. ROUND METRICS: Create EXACTLY ${videoRounds} entries in roundByRoundMetrics.rounds (for rounds 1-${videoRounds} from video)
3. CARDIO: Create ${videoRounds} roundByRound entries in cardioAnalysis
4. STRENGTHS: Provide 3-5 strengths with scores - ONLY what you OBSERVED in the video
5. WEAKNESSES: Provide 3-5 weaknesses with exploitation strategies - ONLY what you OBSERVED
6. MISTAKES: Provide 3-5 mistake patterns you actually SAW in the video
7. ADJUSTMENTS: Provide 5-6 if/then adjustments
8. Use the fighter's actual name "${fighterName}" throughout the report
9. Be specific and actionable in all recommendations
10. All number scores should be realistic (not all 80s - vary them based on actual observation)

═══════════════════════════════════════════════════════════
CRITICAL REMINDERS
═══════════════════════════════════════════════════════════

🚨 FIGHTER IDENTIFICATION IS PARAMOUNT 🚨
- FIRST confirm you've identified the correct fighter using visual markers
- ${shortsColor ? `Look for ${shortsColor.toUpperCase()} shorts to identify ${fighterName}` : `Use the description to identify ${fighterName}`}
- If you see wrestling/takedowns, ask: WHO is initiating them?
- The person SHOOTING the takedown is the wrestler
- The person BEING taken down may have WEAK takedown defense (not wrestler skills)

- **primaryStyle** MUST reflect what ${fighterName} DOES (not what's done TO them):
  - If ${fighterName} shoots takedowns and controls → "Wrestler" or "Grappler"
  - If ${fighterName} primarily boxes and strikes → "Boxer" or "Striker"
  - If ${fighterName} uses clinch and knees → "Muay Thai Fighter"
  - If ${fighterName} attempts submissions → "BJJ Specialist" or "Submission Grappler"
  - If ${fighterName} IS BEING wrestled/controlled → check their OFFENSE to determine style

- **overallScore** is the THREAT LEVEL (how dangerous they appear):
  - 90-100: Elite, championship caliber performance in the video
  - 80-89: Very skilled, high-level performance
  - 70-79: Skilled, competent performance
  - 60-69: Average, some clear weaknesses shown
  - Below 60: Developing, many areas need improvement

- Do NOT assume based on fighter names - analyze ONLY the video frames
- Do NOT confuse the opponent's skills with ${fighterName}'s skills

RESPOND WITH ONLY THE JSON OBJECT. NO MARKDOWN, NO EXPLANATION, JUST PURE JSON.`;
}

/**
 * Call Claude API with frames and get analysis
 * Sends frames as base64 directly to Claude (no R2 URLs needed)
 */
async function analyzeWithClaude(frames, config) {
  const prompt = buildClaudePrompt(config);

  // Build the content array with images as base64
  const content = [];

  // Add images as base64 (Claude supports up to 20 images efficiently)
  // We'll use a subset of frames if there are too many
  const maxFrames = Math.min(frames.length, 20);
  const step = Math.max(1, Math.floor(frames.length / maxFrames));

  let frameCount = 0;
  for (let i = 0; i < frames.length && frameCount < maxFrames; i += step) {
    const frame = frames[i];
    const base64Data = frame.buffer.toString('base64');

    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: base64Data,
      },
    });
    frameCount++;
  }

  // Add the analysis prompt
  content.push({
    type: 'text',
    text: prompt,
  });

  console.log(`Calling Claude API with ${frameCount} frames...`);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    messages: [
      {
        role: 'user',
        content: content,
      },
    ],
  });

  // Extract the JSON from Claude's response
  const responseText = response.content[0].text;

  // Log raw response for debugging (first 500 chars)
  console.log('Claude raw response (first 500 chars):', responseText.substring(0, 500));

  // Parse JSON with robust extraction
  const analysisData = extractAndParseJSON(responseText);

  // Validate and fix the data to match iOS model exactly
  const validatedData = validateAndFixAnalysisData(analysisData, config);

  return validatedData;
}

/**
 * Extract JSON from Claude's response, handling markdown and extra text
 */
function extractAndParseJSON(text) {
  // Remove markdown code blocks if present
  let cleaned = text.trim();

  // Remove ```json ... ``` or ``` ... ```
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/i, '');

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.log('Direct parse failed, trying to extract JSON object...');
  }

  // Try to find JSON object in text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('Failed to parse extracted JSON:', e.message);
    }
  }

  throw new Error('Could not extract valid JSON from Claude response');
}

/**
 * Normalize config to ensure all dates are ISO8601 strings
 * iOS Swift's JSONEncoder uses Double (seconds since reference date) by default,
 * but JSONDecoder with .iso8601 expects ISO8601 strings
 */
function normalizeConfig(config) {
  if (!config) return config;

  const normalized = { ...config };

  // Convert createdAt if it's a number (Swift's default Date encoding)
  if (typeof normalized.createdAt === 'number') {
    // Swift's reference date is 2001-01-01, Unix epoch is 1970-01-01
    // Difference is 978307200 seconds
    const swiftReferenceOffset = 978307200;
    const unixTimestamp = normalized.createdAt + swiftReferenceOffset;
    normalized.createdAt = new Date(unixTimestamp * 1000).toISOString();
  } else if (!normalized.createdAt) {
    normalized.createdAt = new Date().toISOString();
  }

  // Ensure all required fields exist with correct types
  normalized.id = normalized.id || `config-${Date.now()}`;
  normalized.analysisType = normalized.analysisType || 'single';

  // userFightRounds must be an integer (3 or 5)
  if (typeof normalized.userFightRounds === 'string') {
    normalized.userFightRounds = parseInt(normalized.userFightRounds, 10) || 3;
  } else if (typeof normalized.userFightRounds !== 'number') {
    normalized.userFightRounds = 3;
  }

  // userRole must be a valid string matching iOS enum
  const validRoles = [
    "I'm preparing to fight this opponent",
    "Coach analyzing for student",
    "General study / Analysis"
  ];
  if (!validRoles.includes(normalized.userRole)) {
    normalized.userRole = "I'm preparing to fight this opponent";
  }

  // Optional fields - ensure they're null if not provided (not undefined)
  normalized.sessionTitle = normalized.sessionTitle || null;
  normalized.sessionType = normalized.sessionType || null;
  normalized.sessionSubtitle = normalized.sessionSubtitle || null;
  normalized.fighter1Name = normalized.fighter1Name || null;
  normalized.fighter1Corner = normalized.fighter1Corner || null;
  normalized.fighter1Description = normalized.fighter1Description || null;
  normalized.fighter2Name = normalized.fighter2Name || null;
  normalized.fighter2Corner = normalized.fighter2Corner || null;
  normalized.fighter2Description = normalized.fighter2Description || null;
  normalized.videoURL = normalized.videoURL || null;
  normalized.videoDuration = normalized.videoDuration || null;
  normalized.videoRounds = normalized.videoRounds || null;
  normalized.videoFileSize = normalized.videoFileSize || null;

  console.log('Normalized config:', JSON.stringify(normalized, null, 2));
  return normalized;
}

/**
 * Validate and fix analysis data to match iOS AnalysisReport model exactly
 * Adds default values for missing optional fields, ensures correct types
 */
function validateAndFixAnalysisData(data, config) {
  const userRounds = config.userFightRounds || 3;
  const videoRounds = config.videoRounds || 3;

  // Helper to ensure array
  const ensureArray = (val, defaultArr = []) => Array.isArray(val) ? val : defaultArr;

  // Helper to ensure number
  const ensureNumber = (val, defaultVal = 0) => {
    if (typeof val === 'number') return val;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? defaultVal : parsed;
  };

  // Helper to ensure string
  const ensureString = (val, defaultVal = '') => typeof val === 'string' ? val : defaultVal;

  // Validate fighterIdentification (new field for confirming correct fighter)
  if (!data.fighterIdentification) {
    data.fighterIdentification = {
      confirmedName: config.fighter1Name || 'Unknown Fighter',
      visualIdentifiers: 'Fighter identified based on provided description',
      confidenceLevel: 'Medium'
    };
  } else {
    data.fighterIdentification.confirmedName = ensureString(data.fighterIdentification.confirmedName, config.fighter1Name || 'Unknown');
    data.fighterIdentification.visualIdentifiers = ensureString(data.fighterIdentification.visualIdentifiers, 'Based on description');
    data.fighterIdentification.confidenceLevel = ensureString(data.fighterIdentification.confidenceLevel, 'Medium');
  }
  console.log(`Fighter identification: ${data.fighterIdentification.confirmedName} - ${data.fighterIdentification.visualIdentifiers} (Confidence: ${data.fighterIdentification.confidenceLevel})`);

  // Validate executiveSummary
  if (!data.executiveSummary) {
    data.executiveSummary = {
      overallScore: 70,
      summary: 'Analysis completed.',
      keyFindings: ['Analysis data available'],
      recommendedApproach: 'Review the detailed analysis sections.'
    };
  } else {
    data.executiveSummary.overallScore = ensureNumber(data.executiveSummary.overallScore, 70);
    data.executiveSummary.summary = ensureString(data.executiveSummary.summary, 'Analysis completed.');
    data.executiveSummary.keyFindings = ensureArray(data.executiveSummary.keyFindings, ['Analysis data available']);
    data.executiveSummary.recommendedApproach = ensureString(data.executiveSummary.recommendedApproach, 'See details.');
  }

  // Validate fightingStyleBreakdown
  if (!data.fightingStyleBreakdown) {
    data.fightingStyleBreakdown = {
      primaryStyle: 'Mixed Martial Artist',
      stance: 'Orthodox',
      secondarySkills: [],
      baseMartialArts: ['MMA'],
      styleDescription: 'Fighter shows mixed martial arts abilities.',
      secondaryAttributes: ['Balanced Skillset', 'Adaptable', 'Well-Rounded'],
      comparableFighters: [],
      tacticalTendencies: []
    };
  } else {
    // Ensure new fields exist
    data.fightingStyleBreakdown.secondaryAttributes = ensureArray(data.fightingStyleBreakdown.secondaryAttributes, ['Balanced Skillset']);
    data.fightingStyleBreakdown.comparableFighters = ensureArray(data.fightingStyleBreakdown.comparableFighters, []);
    data.fightingStyleBreakdown.tacticalTendencies = ensureArray(data.fightingStyleBreakdown.tacticalTendencies, []);
  }

  // Validate strikeAnalysis
  if (!data.strikeAnalysis) {
    data.strikeAnalysis = {
      accuracy: 50, volume: 0, powerScore: 50, techniqueScore: 50,
      breakdown: { jabs: 0, crosses: 0, hooks: 0, uppercuts: 0, kicks: 0, knees: 0, elbows: 0 },
      patterns: [], recommendations: []
    };
  } else {
    data.strikeAnalysis.accuracy = ensureNumber(data.strikeAnalysis.accuracy, 50);
    data.strikeAnalysis.volume = ensureNumber(data.strikeAnalysis.volume, 0);
    data.strikeAnalysis.powerScore = ensureNumber(data.strikeAnalysis.powerScore, 50);
    data.strikeAnalysis.techniqueScore = ensureNumber(data.strikeAnalysis.techniqueScore, 50);
    if (!data.strikeAnalysis.breakdown) {
      data.strikeAnalysis.breakdown = { jabs: 0, crosses: 0, hooks: 0, uppercuts: 0, kicks: 0, knees: 0, elbows: 0 };
    }
    data.strikeAnalysis.patterns = ensureArray(data.strikeAnalysis.patterns, []);
    data.strikeAnalysis.recommendations = ensureArray(data.strikeAnalysis.recommendations, []);
  }

  // Validate grapplingAnalysis
  if (!data.grapplingAnalysis) {
    data.grapplingAnalysis = {
      takedownAccuracy: 50, takedownDefense: 50, controlTime: 0, submissionAttempts: 0,
      techniques: [], recommendations: []
    };
  } else {
    data.grapplingAnalysis.takedownAccuracy = ensureNumber(data.grapplingAnalysis.takedownAccuracy, 50);
    data.grapplingAnalysis.takedownDefense = ensureNumber(data.grapplingAnalysis.takedownDefense, 50);
    data.grapplingAnalysis.controlTime = ensureNumber(data.grapplingAnalysis.controlTime, 0);
    data.grapplingAnalysis.submissionAttempts = ensureNumber(data.grapplingAnalysis.submissionAttempts, 0);
  }

  // Validate defenseAnalysis
  if (!data.defenseAnalysis) {
    data.defenseAnalysis = {
      headMovement: 50, footwork: 50, blockingRate: 50, counterStrikeRate: 50,
      vulnerabilities: [], improvements: []
    };
  }

  // Validate cardioAnalysis
  if (!data.cardioAnalysis) {
    data.cardioAnalysis = {
      roundByRound: [],
      overallStamina: 70,
      fatigueIndicators: [],
      recommendations: []
    };
  }
  // Ensure roundByRound has correct number of entries
  if (!data.cardioAnalysis.roundByRound || data.cardioAnalysis.roundByRound.length === 0) {
    data.cardioAnalysis.roundByRound = [];
    for (let i = 1; i <= videoRounds; i++) {
      data.cardioAnalysis.roundByRound.push({
        roundNumber: i, outputLevel: 80, staminaScore: 80, notes: `Round ${i} performance`
      });
    }
  }

  // Validate fightIQ
  if (!data.fightIQ) {
    data.fightIQ = {
      overallScore: 70, decisionMaking: 70, adaptability: 70, strategyExecution: 70,
      keyObservations: [], improvements: []
    };
  }

  // Validate strengthsWeaknesses
  if (!data.strengthsWeaknesses) {
    data.strengthsWeaknesses = {
      strengths: [{ title: 'To be analyzed', description: 'Complete analysis for details', score: 70, statistics: null }],
      weaknesses: [{ title: 'To be analyzed', description: 'Complete analysis for details', severity: 50, exploitablePattern: '', frequency: null, exploitationStrategy: 'See detailed analysis' }],
      opportunitiesToExploit: []
    };
  }
  // Ensure strengths have correct structure
  data.strengthsWeaknesses.strengths = ensureArray(data.strengthsWeaknesses.strengths, []).map(s => ({
    title: ensureString(s.title, 'Strength'),
    description: ensureString(s.description, ''),
    score: ensureNumber(s.score, 70),
    statistics: s.statistics || null
  }));
  // Ensure weaknesses have correct structure
  data.strengthsWeaknesses.weaknesses = ensureArray(data.strengthsWeaknesses.weaknesses, []).map(w => ({
    title: ensureString(w.title, 'Weakness'),
    description: ensureString(w.description, ''),
    severity: ensureNumber(w.severity, 50),
    exploitablePattern: ensureString(w.exploitablePattern, ''),
    frequency: w.frequency || null,
    exploitationStrategy: ensureString(w.exploitationStrategy, '')
  }));

  // Validate mistakePatterns
  if (!data.mistakePatterns) {
    data.mistakePatterns = { patterns: [] };
  }
  data.mistakePatterns.patterns = ensureArray(data.mistakePatterns.patterns, []).map(p => ({
    pattern: ensureString(p.pattern, ''),
    frequency: ensureNumber(p.frequency, 1),
    severity: ensureString(p.severity, 'medium')
  }));

  // Validate counterStrategy
  if (!data.counterStrategy) {
    data.counterStrategy = {
      bestCounter: { style: 'Balanced approach', reason: 'Adapt based on opponent' },
      secondBestCounter: { style: 'Pressure fighting', reason: 'Test their cardio' },
      thirdBestCounter: { style: 'Counter striking', reason: 'Exploit openings' },
      techniquesToEmphasize: []
    };
  }

  // Validate gamePlan
  if (!data.gamePlan) {
    data.gamePlan = {
      overallStrategy: 'Implement a balanced game plan.',
      roundByRound: [],
      roundGamePlans: [],
      keyTactics: [],
      thingsToAvoid: []
    };
  }
  // Ensure roundByRound has correct number of entries
  if (!data.gamePlan.roundByRound || data.gamePlan.roundByRound.length < userRounds) {
    data.gamePlan.roundByRound = [];
    for (let i = 1; i <= userRounds; i++) {
      data.gamePlan.roundByRound.push({
        roundNumber: i,
        objective: `Round ${i} objective`,
        tactics: ['Stay focused', 'Execute game plan'],
        keyFocus: 'Maintain composure'
      });
    }
  }
  // Ensure roundGamePlans has correct number of entries
  if (!data.gamePlan.roundGamePlans || data.gamePlan.roundGamePlans.length < userRounds) {
    data.gamePlan.roundGamePlans = [];
    for (let i = 1; i <= userRounds; i++) {
      data.gamePlan.roundGamePlans.push({
        roundNumber: i,
        title: `Round ${i} Strategy`,
        planA: { name: 'Primary Plan', goal: 'Execute strategy', tactics: ['Stay focused'], successIndicators: ['Landing strikes'], switchTrigger: 'If not working, switch' },
        planB: { name: 'Backup Plan', goal: 'Adjust approach', tactics: ['Change rhythm'], successIndicators: ['Creating openings'], switchTrigger: 'If needed' },
        planC: { name: 'Emergency Plan', goal: 'Survive and recover', tactics: ['Clinch and control'], successIndicators: ['Regaining composure'], switchTrigger: null }
      });
    }
  }

  // Validate midFightAdjustments
  if (!data.midFightAdjustments) {
    data.midFightAdjustments = { adjustments: [] };
  }
  data.midFightAdjustments.adjustments = ensureArray(data.midFightAdjustments.adjustments, []).map(a => ({
    ifCondition: ensureString(a.ifCondition, 'If opponent adjusts'),
    thenAction: ensureString(a.thenAction, 'Then counter-adjust')
  }));

  // Validate trainingRecommendations
  if (!data.trainingRecommendations) {
    data.trainingRecommendations = {
      priorityDrills: [],
      sparringFocus: [],
      conditioning: []
    };
  }

  // Validate keyInsights
  if (!data.keyInsights) {
    data.keyInsights = {
      criticalObservations: [],
      winConditions: [],
      riskFactors: [],
      finalRecommendation: 'Focus on your strengths and stay disciplined.',
      confidenceLevel: 'Medium'
    };
  }

  // Validate roundByRoundMetrics
  if (!data.roundByRoundMetrics) {
    data.roundByRoundMetrics = { rounds: [] };
  }
  if (!data.roundByRoundMetrics.rounds || data.roundByRoundMetrics.rounds.length < videoRounds) {
    data.roundByRoundMetrics.rounds = [];
    for (let i = 1; i <= videoRounds; i++) {
      data.roundByRoundMetrics.rounds.push({
        roundNumber: i,
        outputLevel: 75,
        notes: `Round ${i}`,
        striking: {
          strikesLanded: 10, strikesAttempted: 20, accuracy: 50,
          significantStrikes: 5, powerStrikes: 3, headStrikes: 4, bodyStrikes: 3, legStrikes: 3, knockdowns: 0
        },
        grappling: {
          takedownsLanded: 0, takedownsAttempted: 1, takedownAccuracy: 0,
          takedownsDefended: 0, takedownDefenseRate: 50, controlTimeSeconds: 0, submissionAttempts: 0, reversals: 0
        },
        defense: {
          strikesAbsorbed: 10, strikesAvoided: 50, headMovementSuccess: 50, takedownsDefended: 0, escapes: 0
        }
      });
    }
  }

  console.log('Validation complete. Data structure verified.');
  return data;
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * Health Check Endpoint
 * GET /
 */
app.get('/', (req, res) => {
  res.json({
    message: 'FightLab AI Backend',
    status: 'online',
    version: '2.0.0',
    endpoints: {
      analyze: 'POST /analyze',
      getAnalysis: 'GET /analysis/:id',
      status: 'GET /api/analysis/status/:id',
      test: 'GET /test-report'
    }
  });
});

/**
 * TEST ENDPOINT - Returns a hardcoded valid AnalysisReport
 * Use this to verify iOS can parse the response format
 * GET /test-report
 */
app.get('/test-report', (req, res) => {
  const testReport = {
    id: "test-123",
    config: {
      id: "config-123",
      analysisType: "single",
      sessionTitle: "Test Session",
      sessionType: "Competition Fight",
      sessionSubtitle: "Test Analysis",
      fighter1Name: "Test Fighter",
      fighter1Corner: "Red",
      fighter1Description: "Test description",
      fighter2Name: null,
      fighter2Corner: null,
      fighter2Description: null,
      videoURL: null,
      videoDuration: 300,
      videoRounds: 3,
      videoFileSize: 1000000,
      userFightRounds: 3,
      userRole: "I'm preparing to fight this opponent",
      createdAt: new Date().toISOString()
    },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "Completed",
    executiveSummary: {
      overallScore: 75,
      summary: "Test analysis summary",
      keyFindings: ["Finding 1", "Finding 2"],
      recommendedApproach: "Test recommendation"
    },
    fightingStyleBreakdown: {
      primaryStyle: "Boxer",
      stance: "Orthodox",
      secondarySkills: ["Wrestling"],
      baseMartialArts: ["Boxing"],
      styleDescription: "Test style description"
    },
    strikeAnalysis: {
      accuracy: 70,
      volume: 100,
      powerScore: 75,
      techniqueScore: 80,
      breakdown: {
        jabs: 30,
        crosses: 20,
        hooks: 15,
        uppercuts: 5,
        kicks: 20,
        knees: 5,
        elbows: 5
      },
      patterns: ["Pattern 1"],
      recommendations: ["Recommendation 1"]
    },
    grapplingAnalysis: {
      takedownAccuracy: 60,
      takedownDefense: 70,
      controlTime: 120,
      submissionAttempts: 2,
      techniques: ["Double leg"],
      recommendations: ["Work on singles"]
    },
    defenseAnalysis: {
      headMovement: 65,
      footwork: 70,
      blockingRate: 75,
      counterStrikeRate: 60,
      vulnerabilities: ["Low kick defense"],
      improvements: ["Check kicks"]
    },
    cardioAnalysis: {
      roundByRound: [
        { roundNumber: 1, outputLevel: 90, staminaScore: 95, notes: "Strong start" },
        { roundNumber: 2, outputLevel: 85, staminaScore: 88, notes: "Good pace" },
        { roundNumber: 3, outputLevel: 80, staminaScore: 82, notes: "Maintained" }
      ],
      overallStamina: 85,
      fatigueIndicators: ["Breathing heavy in R3"],
      recommendations: ["More cardio"]
    },
    fightIQ: {
      overallScore: 75,
      decisionMaking: 78,
      adaptability: 72,
      strategyExecution: 75,
      keyObservations: ["Good reads"],
      improvements: ["Faster adjustments"]
    },
    strengthsWeaknesses: {
      strengths: [
        { title: "Power", description: "Good knockout power", score: 85, statistics: "70% KO rate" }
      ],
      weaknesses: [
        { title: "Cardio", description: "Fades late", severity: 60, exploitablePattern: "Push pace", frequency: "Often", exploitationStrategy: "Pressure in R3" }
      ],
      opportunitiesToExploit: ["Low hands after combos"]
    },
    mistakePatterns: {
      patterns: [
        { pattern: "Drops hands", frequency: 5, severity: "high" }
      ]
    },
    counterStrategy: {
      bestCounter: { style: "Wrestler", reason: "Weak TDD" },
      secondBestCounter: { style: "Pressure Fighter", reason: "Fades late" },
      thirdBestCounter: { style: "Counter Striker", reason: "Predictable" },
      techniquesToEmphasize: ["Leg kicks", "Wrestling"]
    },
    gamePlan: {
      overallStrategy: "Pressure and wrestle",
      roundByRound: [
        { roundNumber: 1, objective: "Establish range", tactics: ["Jab"], keyFocus: "Distance" },
        { roundNumber: 2, objective: "Increase pressure", tactics: ["Combos"], keyFocus: "Volume" },
        { roundNumber: 3, objective: "Finish strong", tactics: ["Wrestle"], keyFocus: "Control" }
      ],
      roundGamePlans: [
        {
          roundNumber: 1,
          title: "Feel Out",
          planA: { name: "Strike", goal: "Land jabs", tactics: ["Jab"], successIndicators: ["Landing"], switchTrigger: "If not working" },
          planB: { name: "Pressure", goal: "Push forward", tactics: ["Walk down"], successIndicators: ["Backing up"], switchTrigger: "If countered" },
          planC: { name: "Wrestle", goal: "Take down", tactics: ["Double leg"], successIndicators: ["Control"], switchTrigger: null }
        },
        {
          roundNumber: 2,
          title: "Build Lead",
          planA: { name: "Volume", goal: "Outwork", tactics: ["Combos"], successIndicators: ["Landing more"], switchTrigger: "If tired" },
          planB: { name: "Counter", goal: "Pick shots", tactics: ["Wait and counter"], successIndicators: ["Clean shots"], switchTrigger: "If pressured" },
          planC: { name: "Clinch", goal: "Control", tactics: ["Clinch work"], successIndicators: ["Knees landing"], switchTrigger: null }
        },
        {
          roundNumber: 3,
          title: "Close Strong",
          planA: { name: "Finish", goal: "Get stoppage", tactics: ["Swarm"], successIndicators: ["Hurt opponent"], switchTrigger: "If behind" },
          planB: { name: "Points", goal: "Win round", tactics: ["Safe shots"], successIndicators: ["Clear round"], switchTrigger: "If ahead" },
          planC: { name: "Survive", goal: "Make it out", tactics: ["Clinch"], successIndicators: ["Not getting finished"], switchTrigger: null }
        }
      ],
      keyTactics: ["Pressure", "Wrestling"],
      thingsToAvoid: ["Standing in pocket"]
    },
    midFightAdjustments: {
      adjustments: [
        { ifCondition: "Getting countered", thenAction: "Add feints" },
        { ifCondition: "Getting taken down", thenAction: "Stay off fence" }
      ]
    },
    trainingRecommendations: {
      priorityDrills: ["Takedown defense"],
      sparringFocus: ["Pressure sparring"],
      conditioning: ["5 round sparring"]
    },
    keyInsights: {
      criticalObservations: ["Weak to pressure"],
      winConditions: ["Wrestle to victory"],
      riskFactors: ["Power in hands"],
      finalRecommendation: "Stick to wrestling",
      confidenceLevel: "High"
    },
    roundByRoundMetrics: {
      rounds: [
        {
          roundNumber: 1,
          outputLevel: 85,
          notes: "Good round",
          striking: {
            strikesLanded: 20,
            strikesAttempted: 35,
            accuracy: 57,
            significantStrikes: 15,
            powerStrikes: 8,
            headStrikes: 10,
            bodyStrikes: 5,
            legStrikes: 5,
            knockdowns: 0
          },
          grappling: {
            takedownsLanded: 1,
            takedownsAttempted: 2,
            takedownAccuracy: 50,
            takedownsDefended: 1,
            takedownDefenseRate: 100,
            controlTimeSeconds: 45,
            submissionAttempts: 0,
            reversals: 0
          },
          defense: {
            strikesAbsorbed: 15,
            strikesAvoided: 60,
            headMovementSuccess: 65,
            takedownsDefended: 1,
            escapes: 0
          }
        },
        {
          roundNumber: 2,
          outputLevel: 80,
          notes: "Solid round",
          striking: {
            strikesLanded: 18,
            strikesAttempted: 30,
            accuracy: 60,
            significantStrikes: 12,
            powerStrikes: 6,
            headStrikes: 8,
            bodyStrikes: 5,
            legStrikes: 5,
            knockdowns: 0
          },
          grappling: {
            takedownsLanded: 2,
            takedownsAttempted: 3,
            takedownAccuracy: 67,
            takedownsDefended: 0,
            takedownDefenseRate: 0,
            controlTimeSeconds: 60,
            submissionAttempts: 1,
            reversals: 0
          },
          defense: {
            strikesAbsorbed: 12,
            strikesAvoided: 65,
            headMovementSuccess: 70,
            takedownsDefended: 0,
            escapes: 1
          }
        },
        {
          roundNumber: 3,
          outputLevel: 75,
          notes: "Closed well",
          striking: {
            strikesLanded: 15,
            strikesAttempted: 28,
            accuracy: 54,
            significantStrikes: 10,
            powerStrikes: 5,
            headStrikes: 7,
            bodyStrikes: 4,
            legStrikes: 4,
            knockdowns: 0
          },
          grappling: {
            takedownsLanded: 1,
            takedownsAttempted: 2,
            takedownAccuracy: 50,
            takedownsDefended: 1,
            takedownDefenseRate: 100,
            controlTimeSeconds: 30,
            submissionAttempts: 0,
            reversals: 1
          },
          defense: {
            strikesAbsorbed: 18,
            strikesAvoided: 55,
            headMovementSuccess: 60,
            takedownsDefended: 1,
            escapes: 0
          }
        }
      ]
    }
  };

  console.log('Sending test report...');
  res.json(testReport);
});

/**
 * Main Analysis Endpoint
 * POST /analyze
 *
 * Receives: multipart/form-data with 'frames' (images) and 'config' (JSON)
 * Returns: { analysisId, status: "processing" }
 */
app.post('/analyze', upload.array('frames', 100), async (req, res) => {
  const analysisId = uuidv4();

  try {
    // Parse config from form data
    let config = {};
    if (req.body.config) {
      config = typeof req.body.config === 'string'
        ? JSON.parse(req.body.config)
        : req.body.config;
    }

    const frames = req.files || [];

    if (frames.length === 0) {
      return res.status(400).json({
        error: 'No frames provided',
        message: 'Please upload at least one frame'
      });
    }

    console.log(`Received ${frames.length} frames for analysis ${analysisId}`);
    console.log(`Config:`, JSON.stringify(config, null, 2));

    // Store initial status
    analysisStore.set(analysisId, {
      id: analysisId,
      status: 'processing',
      progress: 0,
      config: config,
      createdAt: new Date().toISOString(),
      frames: frames, // Store frames temporarily for processing
    });

    // Process asynchronously (don't block the response)
    processAnalysis(analysisId).catch(err => {
      console.error(`Analysis ${analysisId} failed:`, err);
      const stored = analysisStore.get(analysisId);
      if (stored) {
        stored.status = 'failed';
        stored.error = err.message;
        delete stored.frames; // Clean up frames
        analysisStore.set(analysisId, stored);
      }
    });

    // Return immediately with analysis ID
    res.json({
      analysisID: analysisId,
      status: 'processing',
      message: 'Analysis started. Poll /api/analysis/status/:id for progress.'
    });

  } catch (error) {
    console.error('Error starting analysis:', error);
    res.status(500).json({
      error: 'Failed to start analysis',
      message: error.message
    });
  }
});

/**
 * Process analysis in background
 */
async function processAnalysis(analysisId) {
  const stored = analysisStore.get(analysisId);
  const frames = stored.frames;
  const config = stored.config;

  try {
    // Update progress - starting analysis
    stored.progress = 10;
    analysisStore.set(analysisId, stored);

    console.log(`Processing ${frames.length} frames with Claude...`);

    // Update progress
    stored.progress = 30;
    analysisStore.set(analysisId, stored);

    // Call Claude API with frames directly
    const analysisData = await analyzeWithClaude(frames, config);

    stored.progress = 90;
    analysisStore.set(analysisId, stored);

    // Build complete response matching iOS AnalysisReport model
    // CRITICAL: Normalize config to ensure dates are ISO8601 strings
    const normalizedConfig = normalizeConfig(config);

    const completeReport = {
      id: analysisId,
      config: normalizedConfig,
      createdAt: stored.createdAt,
      completedAt: new Date().toISOString(),
      status: 'Completed',
      ...analysisData  // Spread all the analysis sections from Claude
    };

    // Store complete report and clean up frames
    stored.status = 'completed';
    stored.progress = 100;
    stored.report = completeReport;
    delete stored.frames; // Free up memory
    analysisStore.set(analysisId, stored);

    console.log(`Analysis ${analysisId} completed successfully`);

  } catch (error) {
    console.error(`Analysis ${analysisId} failed:`, error);
    stored.status = 'failed';
    stored.error = error.message;
    delete stored.frames; // Clean up frames
    analysisStore.set(analysisId, stored);
    throw error;
  }
}

/**
 * Check Analysis Status
 * GET /api/analysis/status/:id
 *
 * Returns: { status, progress, message }
 */
app.get('/api/analysis/status/:id', (req, res) => {
  const { id } = req.params;
  const stored = analysisStore.get(id);

  if (!stored) {
    return res.status(404).json({
      error: 'Analysis not found',
      message: `No analysis found with ID: ${id}`
    });
  }

  // Map internal status to iOS AnalysisStatus enum values
  const statusMap = {
    'processing': 'Processing',
    'completed': 'Completed',
    'failed': 'Failed'
  };

  res.json({
    status: statusMap[stored.status] || stored.status,
    progress: stored.progress,
    message: stored.status === 'completed'
      ? 'Analysis complete'
      : stored.status === 'failed'
        ? stored.error || 'Analysis failed'
        : 'Analysis in progress'
  });
});

/**
 * Get Complete Analysis Report
 * GET /analysis/:id
 *
 * Returns: Complete AnalysisReport matching iOS model
 */
app.get('/analysis/:id', (req, res) => {
  const { id } = req.params;
  const stored = analysisStore.get(id);

  if (!stored) {
    return res.status(404).json({
      error: 'Analysis not found',
      message: `No analysis found with ID: ${id}`
    });
  }

  if (stored.status !== 'completed') {
    return res.status(202).json({
      message: 'Analysis not yet complete',
      status: stored.status,
      progress: stored.progress
    });
  }

  res.json(stored.report);
});

/**
 * Alternative endpoint path (for iOS compatibility)
 * GET /api/analysis/report/:id
 */
app.get('/api/analysis/report/:id', (req, res) => {
  const { id } = req.params;
  const stored = analysisStore.get(id);

  if (!stored) {
    return res.status(404).json({
      error: 'Analysis not found',
      message: `No analysis found with ID: ${id}`
    });
  }

  if (stored.status !== 'completed') {
    return res.status(202).json({
      message: 'Analysis not yet complete',
      status: stored.status,
      progress: stored.progress
    });
  }

  res.json(stored.report);
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           FightLab AI Backend Server v2.0.0                ║
╠════════════════════════════════════════════════════════════╣
║  Status: ONLINE                                            ║
║  Port: ${PORT}                                                ║
║                                                            ║
║  Endpoints:                                                ║
║  • GET  /                        - Health check            ║
║  • POST /analyze                 - Submit frames           ║
║  • GET  /api/analysis/status/:id - Check progress          ║
║  • GET  /analysis/:id            - Get complete report     ║
║  • GET  /api/analysis/report/:id - Get report (alt path)   ║
╚════════════════════════════════════════════════════════════╝
  `);
});
