/**
 * FightLab AI Backend Server
 *
 * This server handles:
 * 1. Receiving video frames from the iOS app
 * 2. Uploading frames to Cloudflare R2 (temporary storage)
 * 3. Calling Claude AI to analyze the fight
 * 4. Returning structured analysis matching the iOS app's data models
 * 5. Cleaning up frames from R2 after analysis
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
app.use(express.json({ limit: '50mb' }));

// ============================================
// CLOUDFLARE R2 SETUP (S3-Compatible)
// ============================================

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME || 'fightlabai-videos';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || `https://${R2_BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

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
const frameUrlStore = new Map(); // Stores frame URLs for cleanup

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Upload a single frame to Cloudflare R2
 * Returns the public URL of the uploaded frame
 */
async function uploadFrameToR2(frameBuffer, analysisId, frameIndex) {
  const key = `${analysisId}/frame_${String(frameIndex).padStart(3, '0')}.jpg`;

  await r2Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: frameBuffer,
    ContentType: 'image/jpeg',
  }));

  // Return the URL that Claude can access
  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Delete all frames for an analysis from R2
 * Called after Claude finishes analyzing to save storage costs
 */
async function deleteFramesFromR2(analysisId, frameCount) {
  const deletePromises = [];

  for (let i = 0; i < frameCount; i++) {
    const key = `${analysisId}/frame_${String(i).padStart(3, '0')}.jpg`;
    deletePromises.push(
      r2Client.send(new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      })).catch(err => console.error(`Failed to delete ${key}:`, err))
    );
  }

  await Promise.all(deletePromises);
  console.log(`Deleted ${frameCount} frames for analysis ${analysisId}`);
}

/**
 * Build the Claude prompt with EXACT JSON schema matching iOS models
 * This is CRITICAL - the JSON structure must match AnalysisReport.swift exactly
 */
function buildClaudePrompt(config) {
  const fighterName = config.fighter1Name || 'the fighter';
  const userRounds = config.userFightRounds || 3;
  const videoRounds = config.videoRounds || 3;
  const sessionType = config.sessionType || 'competition';

  // Build fighter context
  let fighterContext = '';
  if (config.analysisType === 'both') {
    fighterContext = `
ANALYZING: Both Fighters
FIGHTER 1: ${config.fighter1Name || 'Fighter 1'} (${config.fighter1Corner || 'Unknown'} Corner)
${config.fighter1Description ? `APPEARANCE: ${config.fighter1Description}` : ''}
FIGHTER 2: ${config.fighter2Name || 'Fighter 2'} (${config.fighter2Corner || 'Unknown'} Corner)
${config.fighter2Description ? `APPEARANCE: ${config.fighter2Description}` : ''}`;
  } else {
    fighterContext = `
FIGHTER: ${fighterName} (${config.fighter1Corner || 'Unknown'} Corner)
${config.fighter1Description ? `APPEARANCE: ${config.fighter1Description}` : ''}`;
  }

  const roleContext = {
    'fighter': 'Fighter preparing to face this opponent',
    'coach': 'Coach analyzing for their student/fighter',
    'study': 'General study and analysis purposes'
  }[config.userRole] || 'General analysis';

  return `You are an expert MMA fight analyst. Analyze the provided fight video frames and generate a comprehensive tactical analysis.

═══════════════════════════════════════════════════════════
FIGHTER INFORMATION
═══════════════════════════════════════════════════════════
${fighterContext}

VIDEO: ${videoRounds} rounds of ${sessionType}
USER'S UPCOMING FIGHT: ${userRounds} rounds
USER CONTEXT: ${roleContext}

═══════════════════════════════════════════════════════════
CRITICAL: JSON OUTPUT FORMAT
═══════════════════════════════════════════════════════════

You MUST respond with ONLY valid JSON matching this EXACT structure.
Use camelCase for all field names. All scores are 0-100 unless noted.

{
  "executiveSummary": {
    "overallScore": <number 0-100>,
    "summary": "<string: 2-3 sentence overview>",
    "keyFindings": ["<string>", "<string>", "<string>", "<string>"],
    "recommendedApproach": "<string: overall strategy recommendation>"
  },

  "fightingStyleBreakdown": {
    "primaryStyle": "<string: e.g., 'Orthodox Boxer', 'Wrestler', 'Muay Thai Fighter'>",
    "stance": "<string: 'Orthodox' or 'Southpaw'>",
    "secondarySkills": ["<string>", "<string>"],
    "baseMartialArts": ["<string: e.g., 'Boxing', 'Wrestling', 'BJJ'>"],
    "styleDescription": "<string: detailed style description>"
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
4. STRENGTHS: Provide 3-5 strengths with scores
5. WEAKNESSES: Provide 3-5 weaknesses with exploitation strategies
6. MISTAKES: Provide 3-5 mistake patterns
7. ADJUSTMENTS: Provide 5-6 if/then adjustments
8. Use the fighter's actual name "${fighterName}" throughout the report
9. Be specific and actionable in all recommendations
10. All number scores should be realistic (not all 80s - vary them based on actual observation)

RESPOND WITH ONLY THE JSON OBJECT. NO MARKDOWN, NO EXPLANATION, JUST PURE JSON.`;
}

/**
 * Call Claude API with frames and get analysis
 */
async function analyzeWithClaude(frameUrls, config) {
  const prompt = buildClaudePrompt(config);

  // Build the content array with images
  const content = [];

  // Add images (Claude can handle up to 100 images)
  for (const url of frameUrls) {
    content.push({
      type: 'image',
      source: {
        type: 'url',
        url: url,
      },
    });
  }

  // Add the analysis prompt
  content.push({
    type: 'text',
    text: prompt,
  });

  console.log(`Calling Claude API with ${frameUrls.length} frames...`);

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

  // Parse and validate JSON
  try {
    const analysisData = JSON.parse(responseText);
    return analysisData;
  } catch (parseError) {
    // Try to extract JSON if Claude added any extra text
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('Failed to parse Claude response as JSON');
  }
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
      status: 'GET /api/analysis/status/:id'
    }
  });
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

    // Store initial status
    analysisStore.set(analysisId, {
      id: analysisId,
      status: 'processing',
      progress: 0,
      config: config,
      createdAt: new Date().toISOString(),
    });

    // Process asynchronously (don't block the response)
    processAnalysis(analysisId, frames, config).catch(err => {
      console.error(`Analysis ${analysisId} failed:`, err);
      const stored = analysisStore.get(analysisId);
      if (stored) {
        stored.status = 'failed';
        stored.error = err.message;
        analysisStore.set(analysisId, stored);
      }
    });

    // Return immediately with analysis ID
    res.json({
      analysisId: analysisId,
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
async function processAnalysis(analysisId, frames, config) {
  const stored = analysisStore.get(analysisId);

  try {
    // Step 1: Upload frames to R2 (30% progress)
    console.log(`Uploading ${frames.length} frames to R2...`);
    const frameUrls = [];

    for (let i = 0; i < frames.length; i++) {
      const url = await uploadFrameToR2(frames[i].buffer, analysisId, i);
      frameUrls.push(url);

      // Update progress
      stored.progress = Math.round((i / frames.length) * 30);
      analysisStore.set(analysisId, stored);
    }

    // Store frame URLs for cleanup later
    frameUrlStore.set(analysisId, { count: frames.length });

    console.log(`Uploaded ${frameUrls.length} frames to R2`);
    stored.progress = 30;
    analysisStore.set(analysisId, stored);

    // Step 2: Call Claude API (30-90% progress)
    console.log('Calling Claude API for analysis...');
    stored.progress = 35;
    analysisStore.set(analysisId, stored);

    const analysisData = await analyzeWithClaude(frameUrls, config);

    stored.progress = 90;
    analysisStore.set(analysisId, stored);

    // Step 3: Build complete response matching iOS AnalysisReport model
    const completeReport = {
      id: analysisId,
      config: config,
      createdAt: stored.createdAt,
      completedAt: new Date().toISOString(),
      status: 'Completed',
      ...analysisData  // Spread all the analysis sections from Claude
    };

    // Store complete report
    stored.status = 'completed';
    stored.progress = 100;
    stored.report = completeReport;
    analysisStore.set(analysisId, stored);

    console.log(`Analysis ${analysisId} completed successfully`);

    // Step 4: Cleanup - Delete frames from R2
    const frameData = frameUrlStore.get(analysisId);
    if (frameData) {
      await deleteFramesFromR2(analysisId, frameData.count);
      frameUrlStore.delete(analysisId);
    }

  } catch (error) {
    console.error(`Analysis ${analysisId} failed:`, error);
    stored.status = 'failed';
    stored.error = error.message;
    analysisStore.set(analysisId, stored);

    // Still try to cleanup frames on error
    const frameData = frameUrlStore.get(analysisId);
    if (frameData) {
      await deleteFramesFromR2(analysisId, frameData.count).catch(() => {});
      frameUrlStore.delete(analysisId);
    }

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
║  • GET  /                      - Health check              ║
║  • POST /analyze               - Submit frames for analysis║
║  • GET  /api/analysis/status/:id - Check progress          ║
║  • GET  /analysis/:id          - Get complete report       ║
║  • GET  /api/analysis/report/:id - Get report (alt path)   ║
╚════════════════════════════════════════════════════════════╝
  `);
});
