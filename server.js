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
 * Helper function to determine user role type from config
 * Returns: 'fighter', 'coach', or 'study'
 */
function getUserRoleType(userRole) {
  if (!userRole) return 'fighter'; // default to fighter mode

  if (userRole.toLowerCase().includes('preparing to fight') ||
      userRole.toLowerCase().includes('fighter')) {
    return 'fighter';
  }
  if (userRole.toLowerCase().includes('coach')) {
    return 'coach';
  }
  if (userRole.toLowerCase().includes('study') ||
      userRole.toLowerCase().includes('analysis') ||
      userRole.toLowerCase().includes('general')) {
    return 'study';
  }
  return 'fighter'; // default
}

/**
 * Helper function to build appearance string from structured data
 */
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

/**
 * Calculate maximum reasonable rounds from video duration
 * Assumes ~5 min/round + 1 min rest = 6 min per full round
 * Returns: { maxRounds, videoDurationMinutes, canDetermineRounds }
 */
function calculateVideoRoundConstraints(videoDurationSeconds) {
  if (!videoDurationSeconds || videoDurationSeconds <= 0) {
    return { maxRounds: 1, videoDurationMinutes: 0, canDetermineRounds: false };
  }

  const minutes = videoDurationSeconds / 60;
  // Conservative: assume 4-5 min rounds (sparring/training can be shorter)
  // A 7-minute video can have at most 1-2 rounds
  const maxRounds = Math.max(1, Math.ceil(minutes / 4));

  return {
    maxRounds,
    videoDurationMinutes: Math.round(minutes * 10) / 10, // Round to 1 decimal
    canDetermineRounds: true
  };
}

/**
 * Build prompt for BOTH FIGHTERS analysis mode
 * Returns a different JSON schema with fighter1Analysis and fighter2Analysis objects
 * Role-based output:
 *   - fighter: Full user-centric coaching with game plans
 *   - coach: Educational/instructional framing
 *   - study: Pure analysis, no game plans or coaching
 */
function buildBothFightersPrompt(config) {
  const fighter1Name = config.fighter1Name || 'Fighter 1';
  const fighter2Name = config.fighter2Name || 'Fighter 2';
  const userRounds = config.userFightRounds || 3;

  // Calculate reasonable round constraints from video duration
  const videoConstraints = calculateVideoRoundConstraints(config.videoDuration);
  // Clamp videoRounds to what's actually possible based on duration
  const claimedRounds = config.videoRounds || 3;
  const videoRounds = Math.min(claimedRounds, videoConstraints.maxRounds);
  const sessionType = config.sessionType || 'competition';
  const roleType = getUserRoleType(config.userRole);

  const fighter1Appearance = config.fighter1Appearance || {};
  const fighter2Appearance = config.fighter2Appearance || {};

  const fighter1ShortsColor = fighter1Appearance.shortsColor ||
    config.fighter1Description?.match(/(\w+)\s*shorts/i)?.[1] || '';
  const fighter2ShortsColor = fighter2Appearance.shortsColor ||
    config.fighter2Description?.match(/(\w+)\s*shorts/i)?.[1] || '';

  const fighter1AppearanceStr = buildAppearanceString(fighter1Appearance, config.fighter1Description);
  const fighter2AppearanceStr = buildAppearanceString(fighter2Appearance, config.fighter2Description);

  const fighter1Background = config.fighter1DeclaredBackground || null;
  const fighter2Background = config.fighter2DeclaredBackground || null;

  // Role-specific context
  const roleContext = {
    'fighter': 'You are preparing to fight against fighters with these styles.',
    'coach': 'You are a coach analyzing these fighters to help train your students.',
    'study': 'You are studying these fighters for general analysis and understanding.'
  }[roleType];

  // Build user-centric sections (gamePlan, adjustments, training, insights) only for fighter/coach modes
  const buildUserCentricSections = (fighterName, isStudyMode, isFighter) => {
    if (isStudyMode) {
      return ''; // No user-centric sections for study mode
    }

    const perspective = isFighter
      ? { subject: 'USER', action: 'you should', goal: 'your' }
      : { subject: 'your fighter', action: 'your fighter should', goal: "your fighter's" };

    return `
    "gamePlan": {
      "overallStrategy": "<DETAILED 3-4 sentence overall strategy for ${perspective.subject} to beat ${fighterName}. Explain the primary approach, WHY it works against this opponent's style, and how to execute it.>",
      "roundByRound": [{ "roundNumber": <1-${userRounds}>, "objective": "<2-3 sentence round objective explaining WHAT to do and WHY>", "tactics": ["<detailed tactic with explanation>", "<another tactic with context>"], "keyFocus": "<specific focus area for this round>" }],
      "roundGamePlans": [{
        "roundNumber": <1-${userRounds}>,
        "title": "<descriptive round strategy title>",
        "planA": {
          "name": "<clear plan name>",
          "goal": "<2-3 sentence goal explaining what ${perspective.subject} wants to achieve and WHY this works against ${fighterName}>",
          "tactics": ["<detailed tactic: WHAT to do + HOW to do it + WHY it works>", "<second detailed tactic with full explanation>", "<third tactic with context>"],
          "successIndicators": ["<specific sign that the plan is working>", "<another measurable indicator>"],
          "switchTrigger": "<clear condition: when exactly ${perspective.action} switch to Plan B>"
        },
        "planB": {
          "name": "<backup plan name>",
          "goal": "<2-3 sentence backup goal>",
          "tactics": ["<detailed backup tactic with explanation>", "<another backup tactic>"],
          "successIndicators": ["<indicator>"],
          "switchTrigger": "<when to switch to Plan C>"
        },
        "planC": {
          "name": "<emergency plan name>",
          "goal": "<emergency goal focused on survival/reset>",
          "tactics": ["<emergency tactic with explanation>"],
          "successIndicators": ["<sign that emergency plan is working>"],
          "switchTrigger": null
        }
      }],
      "keyTactics": ["<DETAILED key tactic: explain WHAT, HOW, and WHY this works against ${fighterName}>", "<another detailed tactic with full context>", "<third detailed tactic>"],
      "thingsToAvoid": [
        {
          "avoidance": "<SPECIFIC pattern from video - e.g., 'Entering on a straight line against his counter timing'>",
          "reason": "<WHY dangerous with VIDEO EVIDENCE - e.g., 'When you enter straight, he times a pull-back counter and lands clean - visible multiple times in footage'>",
          "alternative": "<SPECIFIC tactical fix - e.g., 'Enter behind feints, step off-line at 45 degrees, finish with level change if he leans back'>"
        }
      ]
    },
    "midFightAdjustments": {
      "adjustments": [{ "ifCondition": "<if ${perspective.subject} faces this situation vs ${fighterName}>", "thenAction": "<what ${perspective.action} do>" }]
    },
    "trainingRecommendations": {
      "priorityDrills": ["<drill ${perspective.subject} should practice to beat ${fighterName}>"],
      "sparringFocus": ["<sparring focus for ${perspective.subject}>"],
      "conditioning": ["<conditioning for ${perspective.subject}>"]
    },
    "keyInsights": {
      "criticalObservations": ["<key observation about ${fighterName} that ${perspective.subject} should know>"],
      "winConditions": ["<how ${perspective.subject} wins against ${fighterName}>"],
      "riskFactors": ["<danger ${perspective.subject} faces against ${fighterName}>"],
      "finalRecommendation": "<final advice for ${perspective.subject} fighting ${fighterName}>",
      "confidenceLevel": "<High/Medium/Low>"
    }`;
  };

  const isFighterMode = roleType === 'fighter';
  const isStudyMode = roleType === 'study';
  const fighter1UserSections = buildUserCentricSections(fighter1Name, isStudyMode, isFighterMode);
  const fighter2UserSections = buildUserCentricSections(fighter2Name, isStudyMode, isFighterMode);

  return `You are an expert MMA fight analyst. Analyze the provided fight video frames and generate a comprehensive tactical analysis for BOTH FIGHTERS.

═══════════════════════════════════════════════════════════
🚨 BOTH FIGHTERS ANALYSIS MODE 🚨
═══════════════════════════════════════════════════════════

You MUST provide SEPARATE, COMPLETE analyses for BOTH fighters in this video.

FIGHTER 1: ${fighter1Name} (${config.fighter1Corner || 'Unknown'} Corner)
${fighter1ShortsColor ? `🎯 SHORTS COLOR: ${fighter1ShortsColor.toUpperCase()} - PRIMARY IDENTIFIER` : ''}
${fighter1AppearanceStr ? `APPEARANCE: ${fighter1AppearanceStr}` : ''}
${fighter1Background ? `DECLARED BACKGROUND: ${fighter1Background}` : ''}

FIGHTER 2: ${fighter2Name} (${config.fighter2Corner || 'Unknown'} Corner)
${fighter2ShortsColor ? `🎯 SHORTS COLOR: ${fighter2ShortsColor.toUpperCase()} - PRIMARY IDENTIFIER` : ''}
${fighter2AppearanceStr ? `APPEARANCE: ${fighter2AppearanceStr}` : ''}
${fighter2Background ? `DECLARED BACKGROUND: ${fighter2Background}` : ''}

═══════════════════════════════════════════════════════════
🚨🚨🚨 CRITICAL: VIDEO-GROUNDED ANALYSIS ONLY 🚨🚨🚨
═══════════════════════════════════════════════════════════

VIDEO DURATION: ${videoConstraints.videoDurationMinutes} minutes
MAXIMUM POSSIBLE ROUNDS: ${videoRounds} (based on video length)
SESSION TYPE: ${sessionType}
USER'S UPCOMING FIGHT: ${userRounds} rounds

⚠️ ABSOLUTE RULES - VIOLATION = ANALYSIS FAILURE:

1. **NO ROUND HALLUCINATIONS**: A ${videoConstraints.videoDurationMinutes}-minute video can have AT MOST ${videoRounds} round(s).
   - NEVER claim "Round 3" events in a video under 10 minutes
   - NEVER claim "Round 5" events in a video under 20 minutes
   - If round breaks are not VISIBLE, use "throughout the video" or "in the footage"

2. **VIDEO-ONLY OBSERVATIONS**: Only describe what you ACTUALLY SEE in these frames.
   - Do NOT invent specific round-by-round events unless you can SEE round breaks
   - Use language like: "Throughout the video...", "Across the footage...", "Observed patterns show..."
   - If you cannot distinguish rounds, analyze as ONE continuous session

3. **NO TEMPLATED CONTENT**: Every piece of analysis must be SPECIFIC to THIS video.
   - Generic phrases like "This pattern was identified as a vulnerability" are FORBIDDEN
   - Every reason/alternative/observation must reference SPECIFIC actions from the video

ANALYSIS MODE: ${roleType.toUpperCase()}

═══════════════════════════════════════════════════════════
CRITICAL: JSON OUTPUT FORMAT FOR BOTH FIGHTERS
═══════════════════════════════════════════════════════════

You MUST respond with ONLY valid JSON matching this EXACT structure.
Each fighter gets their OWN complete analysis with all sections.

{
  "fighter1Analysis": {
    "fighterIdentification": {
      "confirmedName": "${fighter1Name}",
      "visualIdentifiers": "<how you identified ${fighter1Name}>",
      "confidenceLevel": "<High/Medium/Low>",
      "observedStyle": "<style observed for ${fighter1Name}>",
      "declaredBackground": "${fighter1Background || 'Not specified'}",
      "styleMismatch": <boolean>
    },
    "executiveSummary": {
      "overallScore": <0-100>,
      "summary": "<DETAILED 5-7 sentence comprehensive overview of ${fighter1Name}. Include fighting style, key strengths, notable weaknesses, performance under pressure, and threat assessment.>",
      "keyFindings": ["<detailed finding with context>", "<finding with tactical implication>", "<pattern with frequency>", "<vulnerability with exploitation method>"],
      "recommendedApproach": "<DETAILED 4-6 sentence strategic recommendation for fighting ${fighter1Name}. Explain primary strategy and WHY it works, backup approach, key techniques, and what to avoid.>"
    },
    "fightingStyleBreakdown": {
      "primaryStyle": "<${fighter1Name}'s primary style>",
      "stance": "<Orthodox/Southpaw>",
      "secondarySkills": ["<skill>"],
      "baseMartialArts": ["<art>"],
      "styleDescription": "<description>",
      "secondaryAttributes": ["<attribute>"],
      "comparableFighters": ["<fighter>"],
      "tacticalTendencies": ["<tendency>"]
    },
    "strikeAnalysis": {
      "accuracy": <0-100>, "volume": <int>, "powerScore": <0-100>, "techniqueScore": <0-100>,
      "breakdown": { "jabs": <int>, "crosses": <int>, "hooks": <int>, "uppercuts": <int>, "kicks": <int>, "knees": <int>, "elbows": <int> },
      "patterns": ["<pattern>"], "recommendations": ["<rec>"]
    },
    "grapplingAnalysis": {
      "takedownAccuracy": <0-100>, "takedownDefense": <0-100>, "controlTime": <seconds>, "submissionAttempts": <int>,
      "techniques": ["<technique>"], "recommendations": ["<rec>"]
    },
    "defenseAnalysis": {
      "headMovement": <0-100>, "footwork": <0-100>, "blockingRate": <0-100>, "counterStrikeRate": <0-100>,
      "vulnerabilities": ["<vulnerability>"], "improvements": ["<improvement>"]
    },
    "cardioAnalysis": {
      "roundByRound": [{ "roundNumber": <int>, "outputLevel": <0-100>, "staminaScore": <0-100>, "notes": "<note>" }],
      "overallStamina": <0-100>, "fatigueIndicators": ["<indicator>"], "recommendations": ["<rec>"]
    },
    "fightIQ": {
      "overallScore": <0-100>, "decisionMaking": <0-100>, "adaptability": <0-100>, "strategyExecution": <0-100>,
      "keyObservations": ["<observation>"], "improvements": ["<improvement>"]
    },
    "strengthsWeaknesses": {
      "strengths": [{ "title": "<title>", "description": "<desc>", "score": <0-100>, "statistics": "<stat or null>" }],
      "weaknesses": [{ "title": "<title>", "description": "<desc>", "severity": <0-100>, "exploitablePattern": "<pattern>", "frequency": "<freq or null>", "exploitationStrategy": "<strategy>" }],
      "opportunitiesToExploit": ["<opportunity>"]
    },
    "mistakePatterns": {
      "patterns": [{ "pattern": "<pattern>", "frequency": <int>, "severity": "<high/medium/low>" }]
    },
    "counterStrategy": {
      "bestCounter": { "style": "<style>", "reason": "<reason>" },
      "secondBestCounter": { "style": "<style>", "reason": "<reason>" },
      "thirdBestCounter": { "style": "<style>", "reason": "<reason>" },
      "techniquesToEmphasize": ["<technique>"]
    },
    "roundByRoundMetrics": {
      "rounds": [{ "roundNumber": <int>, "outputLevel": <0-100>, "notes": "<note>",
        "striking": { "strikesLanded": <int>, "strikesAttempted": <int>, "accuracy": <0-100>, "significantStrikes": <int>, "powerStrikes": <int>, "headStrikes": <int>, "bodyStrikes": <int>, "legStrikes": <int>, "knockdowns": <int> },
        "grappling": { "takedownsLanded": <int>, "takedownsAttempted": <int>, "takedownAccuracy": <0-100>, "takedownsDefended": <int>, "takedownDefenseRate": <0-100>, "controlTimeSeconds": <int>, "submissionAttempts": <int>, "reversals": <int> },
        "defense": { "strikesAbsorbed": <int>, "strikesAvoided": <0-100>, "headMovementSuccess": <0-100>, "takedownsDefended": <int>, "escapes": <int> }
      }]
    }${fighter1UserSections}
  },

  "fighter2Analysis": {
    "fighterIdentification": {
      "confirmedName": "${fighter2Name}",
      "visualIdentifiers": "<how you identified ${fighter2Name}>",
      "confidenceLevel": "<High/Medium/Low>",
      "observedStyle": "<style observed for ${fighter2Name}>",
      "declaredBackground": "${fighter2Background || 'Not specified'}",
      "styleMismatch": <boolean>
    },
    "executiveSummary": {
      "overallScore": <0-100>,
      "summary": "<DETAILED 5-7 sentence comprehensive overview of ${fighter2Name}. Include fighting style, key strengths, notable weaknesses, performance under pressure, and threat assessment.>",
      "keyFindings": ["<detailed finding with context>", "<finding with tactical implication>", "<pattern with frequency>", "<vulnerability with exploitation method>"],
      "recommendedApproach": "<DETAILED 4-6 sentence strategic recommendation for fighting ${fighter2Name}. Explain primary strategy and WHY it works, backup approach, key techniques, and what to avoid.>"
    },
    "fightingStyleBreakdown": {
      "primaryStyle": "<${fighter2Name}'s primary style>",
      "stance": "<Orthodox/Southpaw>",
      "secondarySkills": ["<skill>"],
      "baseMartialArts": ["<art>"],
      "styleDescription": "<description>",
      "secondaryAttributes": ["<attribute>"],
      "comparableFighters": ["<fighter>"],
      "tacticalTendencies": ["<tendency>"]
    },
    "strikeAnalysis": {
      "accuracy": <0-100>, "volume": <int>, "powerScore": <0-100>, "techniqueScore": <0-100>,
      "breakdown": { "jabs": <int>, "crosses": <int>, "hooks": <int>, "uppercuts": <int>, "kicks": <int>, "knees": <int>, "elbows": <int> },
      "patterns": ["<pattern>"], "recommendations": ["<rec>"]
    },
    "grapplingAnalysis": {
      "takedownAccuracy": <0-100>, "takedownDefense": <0-100>, "controlTime": <seconds>, "submissionAttempts": <int>,
      "techniques": ["<technique>"], "recommendations": ["<rec>"]
    },
    "defenseAnalysis": {
      "headMovement": <0-100>, "footwork": <0-100>, "blockingRate": <0-100>, "counterStrikeRate": <0-100>,
      "vulnerabilities": ["<vulnerability>"], "improvements": ["<improvement>"]
    },
    "cardioAnalysis": {
      "roundByRound": [{ "roundNumber": <int>, "outputLevel": <0-100>, "staminaScore": <0-100>, "notes": "<note>" }],
      "overallStamina": <0-100>, "fatigueIndicators": ["<indicator>"], "recommendations": ["<rec>"]
    },
    "fightIQ": {
      "overallScore": <0-100>, "decisionMaking": <0-100>, "adaptability": <0-100>, "strategyExecution": <0-100>,
      "keyObservations": ["<observation>"], "improvements": ["<improvement>"]
    },
    "strengthsWeaknesses": {
      "strengths": [{ "title": "<title>", "description": "<desc>", "score": <0-100>, "statistics": "<stat or null>" }],
      "weaknesses": [{ "title": "<title>", "description": "<desc>", "severity": <0-100>, "exploitablePattern": "<pattern>", "frequency": "<freq or null>", "exploitationStrategy": "<strategy>" }],
      "opportunitiesToExploit": ["<opportunity>"]
    },
    "mistakePatterns": {
      "patterns": [{ "pattern": "<pattern>", "frequency": <int>, "severity": "<high/medium/low>" }]
    },
    "counterStrategy": {
      "bestCounter": { "style": "<style>", "reason": "<reason>" },
      "secondBestCounter": { "style": "<style>", "reason": "<reason>" },
      "thirdBestCounter": { "style": "<style>", "reason": "<reason>" },
      "techniquesToEmphasize": ["<technique>"]
    },
    "roundByRoundMetrics": {
      "rounds": [{ "roundNumber": <int>, "outputLevel": <0-100>, "notes": "<note>",
        "striking": { "strikesLanded": <int>, "strikesAttempted": <int>, "accuracy": <0-100>, "significantStrikes": <int>, "powerStrikes": <int>, "headStrikes": <int>, "bodyStrikes": <int>, "legStrikes": <int>, "knockdowns": <int> },
        "grappling": { "takedownsLanded": <int>, "takedownsAttempted": <int>, "takedownAccuracy": <0-100>, "takedownsDefended": <int>, "takedownDefenseRate": <0-100>, "controlTimeSeconds": <int>, "submissionAttempts": <int>, "reversals": <int> },
        "defense": { "strikesAbsorbed": <int>, "strikesAvoided": <0-100>, "headMovementSuccess": <0-100>, "takedownsDefended": <int>, "escapes": <int> }
      }]
    }${fighter2UserSections}
  },

  "matchupAnalysis": {
    "summary": "<DETAILED 3-4 sentence matchup analysis based on WHAT YOU OBSERVED in the video. Reference specific exchanges, moments, and how each fighter performed AGAINST EACH OTHER.>",
    "keyMatchups": ["<key matchup point observed in the video>", "<another observed interaction>", "<third key observation>", "<fourth observation>"],
    "criticalMoments": ["<IMPORTANT: List any knockdowns, near-finishes, dominant positions, or fight-changing moments you observed - e.g., 'Fighter A knocked down Fighter B in round 2'>"],
    "opponentPreparation": {
      "keyDangers": [
        "<SPECIFIC danger this opponent presents based on video - e.g., 'Explosive overhand right that he loads up when pressured backwards'>",
        "<Another danger observed - e.g., 'Quick level changes into double-leg takedowns from boxing range'>",
        "<Third danger - e.g., 'Clinch knees when backed against the cage'>"
      ],
      "tacticalAdjustments": [
        "<SPECIFIC adjustment needed for this opponent - e.g., 'Maintain longer range than usual to avoid his inside boxing'>",
        "<Another tactical adjustment - e.g., 'Circle away from his power hand rather than backing up straight'>",
        "<Third adjustment - e.g., 'Keep hands high when pressing forward - he counters with hooks'>"
      ],
      "preparationGuidance": [
        "<HOW to prepare for this specific opponent - e.g., 'Drill sprawl-to-guillotine sequences - he leaves his neck exposed on shots'>",
        "<Another preparation tip - e.g., 'Spar against aggressive pressure fighters to simulate his style'>",
        "<Third preparation guidance - e.g., 'Work on maintaining distance and using jabs to keep him at bay'>"
      ],
      "similarStyleGuidance": "<OPTIONAL - Reference to similar fighters or styles - e.g., 'Similar pressure style to early Diego Sanchez - constant forward movement with wide hooks. Study how fighters with good footwork neutralized that approach.'>"
    }
  }
}

═══════════════════════════════════════════════════════════
REQUIREMENTS FOR BOTH FIGHTERS MODE - ${roleType.toUpperCase()} ROLE
═══════════════════════════════════════════════════════════

${roleType === 'study' ? `
🔬 STUDY MODE - NEUTRAL ANALYSIS

You are providing an objective, educational breakdown of both fighters.
NO game plans, NO training recommendations, NO personalized coaching.

FOR EACH FIGHTER'S ANALYSIS:
1. Summary, Style, Strengths, Weaknesses, Mistakes → Objective analysis of each fighter
2. Counter Strategy → General tactical analysis of how to counter this style
3. DO NOT include: gamePlan, midFightAdjustments, trainingRecommendations, keyInsights

Focus on describing WHAT you observe, not prescribing what someone should DO.
Use neutral language: "The fighter demonstrates...", "This style is characterized by..."
` : roleType === 'coach' ? `
🎓 COACH MODE - INSTRUCTIONAL ANALYSIS

You are a coach analyzing these fighters to train your students.
Frame everything from an educational, instructional perspective.

FOR EACH FIGHTER'S ANALYSIS:
1. Summary, Style, Strengths, Weaknesses, Mistakes → ABOUT that fighter (objectively analyze them)
2. Counter Strategy → How to teach a fighter to beat this style
3. Game Plan → Your fighter's round-by-round strategy to beat this opponent
4. Adjustments → What your fighter should do if situations arise
5. Training → What drills and training to prescribe
6. Insights → Key teaching points about this fighter type

Use instructional language: "Your fighter should...", "Teach them to...", "Focus training on..."
` : `
🥊 FIGHTER MODE - USER-CENTRIC COACHING

All output is for THE USER who uploaded this video.
The USER wants to learn how to fight AGAINST fighters like these.

FOR EACH FIGHTER'S ANALYSIS:
1. Summary, Style, Strengths, Weaknesses, Mistakes → ABOUT that fighter (objectively analyze them)
2. Counter Strategy → How USER can beat that fighter type
3. Game Plan → USER's round-by-round strategy to beat that fighter
4. Adjustments → What USER should do if situations arise against that fighter
5. Training → What USER should train to defeat that fighter type
6. Insights → Key observations USER needs to know about that fighter

All game plan content should read as "YOU should do X" or "Your goal is Y" - USER-CENTRIC!
`}

SPECIFIC REQUIREMENTS:
- Give DIFFERENT overallScores for each fighter based on their observed skill level
- roundByRoundMetrics should have ${videoRounds} entries for each fighter
${roleType !== 'study' ? `- Each fighter gets their OWN gamePlan, adjustments, training, insights - NOT shared!
- gamePlan.roundGamePlans should have ${userRounds} entries for each fighter
- Provide 5-6 specific midFightAdjustments per fighter
- Training recommendations must be specific to beating THAT fighter's style` : `- Focus on pure analysis without actionable coaching recommendations`}

═══════════════════════════════════════════════════════════
🚨🚨🚨 ABSOLUTE RULE: VIDEO-FIRST OPPONENT PREPARATION 🚨🚨🚨
═══════════════════════════════════════════════════════════

⚠️ THIS IS THE MOST IMPORTANT SECTION - GET THIS WRONG AND THE ENTIRE ANALYSIS FAILS ⚠️

The matchupAnalysis MUST reflect WHAT ACTUALLY HAPPENED IN THE VIDEO.
Focus on actionable preparation guidance, NOT predictions.

═══════════════════════════════════════════════════════════
🎯 OPPONENT PREPARATION REQUIREMENTS (CRITICAL) 🎯
═══════════════════════════════════════════════════════════

The opponentPreparation section is designed to help users PREPARE for opponents like this.
This is NOT a prediction tool - it's a PREPARATION tool.

FOR "keyDangers" - What specific threats does this opponent present?
- Reference actual moments from the video where these dangers manifested
- Be specific: "Explosive overhand right" not just "good hands"
- Include timing/setup patterns you observed

FOR "tacticalAdjustments" - What should the user change when facing this style?
- Specific range adjustments, stance changes, tactical shifts
- Based on weaknesses you observed in the video
- Actionable advice, not generic statements

FOR "preparationGuidance" - How should the user train for this opponent?
- Specific drills that address the dangers identified
- Sparring recommendations to simulate this style
- Training focus areas based on video analysis

FOR "similarStyleGuidance" - Reference point for preparation
- Name similar fighters or styles to study
- Explain what makes them similar
- Optional but valuable for context

═══════════════════════════════════════════════════════════
📋 CRITICAL MOMENTS RULES 📋
═══════════════════════════════════════════════════════════

The "criticalMoments" array must capture fight-defining events:
- Knockdowns, near-finishes, dominant positions
- Moments that reveal key vulnerabilities
- Turning points that show what works against this opponent

Example: If ${fighter1Name} knocked down ${fighter2Name}, this MUST be in criticalMoments as it reveals a key danger and opportunity.

═══════════════════════════════════════════════════════════
🏆 PREMIUM QUALITY REQUIREMENT - $19.99 ANALYSIS 🏆
═══════════════════════════════════════════════════════════

This is a PREMIUM paid analysis. Users expect DEEP, DETAILED insights - NOT generic summaries.

EVERY text field should be:
- DETAILED: Multiple sentences with specific observations, not 1-2 line summaries
- SPECIFIC: Reference actual moments, techniques, and patterns observed in the video
- ACTIONABLE: Explain WHY something matters and HOW to use the information
- EXPERT-LEVEL: Sound like advice from a professional fight analyst/coach

❌ BAD: "Technical striker with good movement"
✅ GOOD: "Technical counter-striker who excels at controlling distance using a stiff jab and lateral movement. Shows excellent timing on pull-back counters, but reliance on backing straight up under pressure was exploited multiple times."

❌ BAD: "Pressure wrestling with body shots"
✅ GOOD: "Your primary strategy should be pressure wrestling combined with body attacks. Close distance using feints, then shoot when he backs up - his takedown defense deteriorates when moving backward. On the feet, target his body to slow his movement and create further takedown opportunities."

═══════════════════════════════════════════════════════════
📋 GAME PLAN QUALITY REQUIREMENTS (CRITICAL USP) 📋
═══════════════════════════════════════════════════════════

The Game Plan is one of our CORE features. It MUST be detailed and actionable.

FOR "overallStrategy":
❌ BAD: "Pressure and wrestle"
✅ GOOD: "Implement a pressure-based attack focusing on closing distance and initiating clinch exchanges. His poor takedown defense (visible when backing up) creates opportunities for reactive shots. On the feet, target the body to slow his movement and set up takedowns. If he starts finding range, immediately close distance - allowing him to establish his jab rhythm is dangerous."

FOR "thingsToAvoid" - THIS IS CRITICAL, PAY ATTENTION:

🚫 FORBIDDEN GENERIC PHRASES (NEVER USE THESE):
- "This pattern was identified as a vulnerability based on video analysis"
- "Adjust your approach based on opponent reaction"
- "Reset when necessary"
- "This is dangerous for you"
- "Based on analysis"

EVERY reason MUST reference something SPECIFIC you observed.
EVERY alternative MUST be a CONCRETE tactical adjustment.

❌ BAD: { "avoidance": "Don't stand and trade", "reason": "Dangerous", "alternative": "Move" }
✅ GOOD: {
  "avoidance": "Prolonged exchanges at boxing range",
  "reason": "He has faster hands and better timing on counters - he landed clean hooks 4 times when opponent stayed in the pocket too long. Every second spent trading increases your damage accumulation.",
  "alternative": "Close the distance into clinch range or reset completely to outside range. Use feints to draw his counter, then immediately change levels for takedowns."
}

❌ BAD: { "reason": "This pattern was identified as a vulnerability", "alternative": "Adjust your approach" }
✅ GOOD: {
  "avoidance": "Backing up in a straight line under pressure",
  "reason": "When pressured backward, his hands dropped and he ate the overhand right twice - once visibly hurting him",
  "alternative": "Circle off to his power-hand side (his right), keeping your lead hand active. If you must retreat, take an angle and counter off the exit"
}

FOR "tactics" in roundGamePlans:
❌ BAD: "Use leg kicks"
✅ GOOD: "Attack his lead leg with inside and outside low kicks whenever he squares his stance - he showed zero checking ability and his mobility visibly decreased after accumulating leg damage in round 2."

RESPOND WITH ONLY THE JSON OBJECT. NO MARKDOWN, NO EXPLANATION, JUST PURE JSON.`;
}

/**
 * Build the Claude prompt with EXACT JSON schema matching iOS models
 * This is CRITICAL - the JSON structure must match AnalysisReport.swift exactly
 * Role-based output:
 *   - fighter: Full user-centric coaching with game plans
 *   - coach: Educational/instructional framing
 *   - study: Pure analysis, no game plans or coaching
 */
function buildClaudePrompt(config) {
  // For "both" mode, use the special prompt
  if (config.analysisType === 'both') {
    return buildBothFightersPrompt(config);
  }

  const fighterName = config.fighter1Name || 'the fighter';
  const userRounds = config.userFightRounds || 3;

  // Calculate reasonable round constraints from video duration
  const videoConstraints = calculateVideoRoundConstraints(config.videoDuration);
  // Clamp videoRounds to what's actually possible based on duration
  const claimedRounds = config.videoRounds || 3;
  const videoRounds = Math.min(claimedRounds, videoConstraints.maxRounds);

  const sessionType = config.sessionType || 'competition';
  const roleType = getUserRoleType(config.userRole);

  // Extract appearance data (new structured format or legacy string)
  const fighter1Appearance = config.fighter1Appearance || {};

  // Get shorts color - prefer structured, fall back to legacy description parsing
  const shortsColor = fighter1Appearance.shortsColor ||
    config.fighter1Description?.match(/(\w+)\s*shorts/i)?.[1] || '';

  const fighter1AppearanceStr = buildAppearanceString(fighter1Appearance, config.fighter1Description);

  // Get declared backgrounds
  const fighter1Background = config.fighter1DeclaredBackground || null;

  // Build fighter context with STRONG visual emphasis
  let fighterContext = `
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

  const roleContextLabel = {
    'fighter': 'FIGHTER MODE - User preparing to face this opponent',
    'coach': 'COACH MODE - Coach analyzing for their student/fighter',
    'study': 'STUDY MODE - General study and analysis purposes'
  }[roleType] || 'General analysis';

  // Determine if we should include user-centric sections
  const isStudyMode = roleType === 'study';
  const isFighterMode = roleType === 'fighter';

  // Build user-centric sections for the JSON schema - DETAILED for premium $19.99 analysis
  const userCentricJsonSchema = isStudyMode ? '' : `
  "gamePlan": {
    "overallStrategy": "<string: DETAILED 4-5 sentence strategic overview. Explain: (1) The primary game plan philosophy, (2) WHY this approach is effective against this opponent based on observed weaknesses, (3) Key phases of the fight to focus on, (4) Victory conditions and paths to win.>",
    "roundByRound": [
      {
        "roundNumber": <integer: 1 to ${userRounds}>,
        "objective": "<string: DETAILED 2-3 sentence round objective explaining WHAT to accomplish and WHY it sets up later rounds>",
        "tactics": ["<string: specific tactic with explanation of execution>", "<string>", "<string>"],
        "keyFocus": "<string: main focus with reasoning - e.g., 'Establish jab to set up takedown entries because opponent overreacts to strikes'>"
      }
    ],
    "roundGamePlans": [
      {
        "roundNumber": <integer: 1 to ${userRounds}>,
        "title": "<string: descriptive round title - e.g., 'Establish Range Control & Test Takedown Defense'>",
        "planA": {
          "name": "<string: plan name>",
          "goal": "<string: DETAILED 2-sentence goal explaining what to achieve and why>",
          "tactics": ["<string: specific tactic with execution detail>", "<string>", "<string>"],
          "successIndicators": ["<string: specific observable sign that plan is working>", "<string>"],
          "switchTrigger": "<string or null: SPECIFIC condition that signals need to switch - e.g., 'If opponent sprawls successfully on 3+ takedown attempts'>"
        },
        "planB": {
          "name": "<string>",
          "goal": "<string: DETAILED goal with reasoning>",
          "tactics": ["<string: specific tactic>", "<string>", "<string>"],
          "successIndicators": ["<string>", "<string>"],
          "switchTrigger": "<string or null>"
        },
        "planC": {
          "name": "<string>",
          "goal": "<string: DETAILED emergency/safety goal>",
          "tactics": ["<string>", "<string>"],
          "successIndicators": ["<string>"],
          "switchTrigger": null
        }
      }
    ],
    "keyTactics": ["<string: key tactic WITH detailed explanation of how and when to use it>", "<string>", "<string>", "<string>"],
    "thingsToAvoid": [
      {
        "avoidance": "<SPECIFIC pattern from video - e.g., 'Entering on a straight line against his counter timing'>",
        "reason": "<WHY dangerous with VIDEO EVIDENCE - e.g., 'When you enter straight, he times a pull-back counter and lands clean - visible multiple times in footage'>",
        "alternative": "<SPECIFIC tactical fix - e.g., 'Enter behind feints, step off-line at 45 degrees, finish with level change if he leans back'>"
      }
    ]
  },

  "midFightAdjustments": {
    "adjustments": [
      {
        "ifCondition": "<string: SPECIFIC observable condition - e.g., 'If opponent starts timing your level changes and sprawling early'>",
        "thenAction": "<string: DETAILED 2-sentence response explaining what to do and why - e.g., 'Switch to body shots to bring their hands down, then shoot when they react to body attack. This creates openings for takedowns by changing their defensive posture.'>"
      }
    ]
  },

  "trainingRecommendations": {
    "priorityDrills": ["<string: specific drill WITH explanation of what it develops and why it's important for this matchup>", "<string>", "<string>"],
    "sparringFocus": ["<string: sparring scenario WITH specific instructions - e.g., 'Spar against tall counter-strikers, focus on closing distance without eating jabs'>", "<string>"],
    "conditioning": ["<string: conditioning protocol WITH reasoning - e.g., 'High-intensity 5-minute rounds with wrestling scrambles to simulate late-round grappling'>", "<string>"]
  },

  "keyInsights": {
    "criticalObservations": ["<string: DETAILED critical observation explaining significance and tactical implication>", "<string>", "<string>", "<string>"],
    "winConditions": ["<string: SPECIFIC path to victory with conditions - e.g., 'Accumulate takedowns in rounds 1-3 to build lead, then control pace in championship rounds'>", "<string>", "<string>"],
    "riskFactors": ["<string: DETAILED risk with explanation of how to mitigate - e.g., 'Risk: Getting caught on entries. Mitigation: Use body shots and feints before shooting'>", "<string>", "<string>"],
    "finalRecommendation": "<string: DETAILED 3-4 sentence final strategic advice synthesizing all insights. Include the #1 priority, backup approach, and key mental focus.>",
    "confidenceLevel": "<string: 'High', 'Medium', or 'Low'>"
  },`;

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
🚨🚨🚨 CRITICAL: VIDEO-GROUNDED ANALYSIS ONLY 🚨🚨🚨
═══════════════════════════════════════════════════════════

VIDEO DURATION: ${videoConstraints.videoDurationMinutes} minutes
MAXIMUM POSSIBLE ROUNDS: ${videoRounds} (based on video length)
SESSION TYPE: ${sessionType}
USER'S UPCOMING FIGHT: ${userRounds} rounds
ANALYSIS MODE: ${roleContextLabel}

⚠️ ABSOLUTE RULES - VIOLATION = ANALYSIS FAILURE:

1. **NO ROUND HALLUCINATIONS**: A ${videoConstraints.videoDurationMinutes}-minute video can have AT MOST ${videoRounds} round(s).
   - NEVER claim "Round 3" events in a video under 10 minutes
   - NEVER claim "Round 5" events in a video under 20 minutes
   - If round breaks are not VISIBLE, use "throughout the video" or "in the footage"

2. **VIDEO-ONLY OBSERVATIONS**: Only describe what you ACTUALLY SEE in these frames.
   - Do NOT invent specific round-by-round events unless you can SEE round breaks
   - Use language like: "Throughout the video...", "Across the footage...", "Observed patterns show..."
   - If you cannot distinguish rounds, analyze as ONE continuous session
   - Do NOT use any prior knowledge about the fighter's name or reputation

3. **NO TEMPLATED CONTENT**: Every piece of analysis must be SPECIFIC to THIS video.
   - Generic phrases like "This pattern was identified as a vulnerability" are FORBIDDEN
   - Every reason/alternative/observation must reference SPECIFIC actions from the video

4. **FIGHTER IDENTIFICATION FIRST**:
   - ONLY analyze what you can actually SEE the TARGET FIGHTER doing
   - If ${fighterName} primarily shoots takedowns and controls → they are a WRESTLER/GRAPPLER
   - If ${fighterName} primarily throws punches and kicks → they are a STRIKER
   - If ${fighterName} IS BEING taken down and controlled → they may have WEAK wrestling (check their offense)

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
    "summary": "<string: DETAILED 5-7 sentence comprehensive overview. Include: (1) Primary fighting style and approach, (2) Key technical strengths observed, (3) Notable weaknesses or tendencies exploited, (4) How they perform under pressure, (5) Overall threat assessment. This should read like expert fight analysis, not a brief summary.>",
    "keyFindings": ["<string: specific detailed observation with context - explain WHY this matters>", "<string: another key finding with tactical implication>", "<string: pattern or tendency with frequency if observed>", "<string: vulnerability or opportunity with exploitation method>", "<string: additional insight>"],
    "recommendedApproach": "<string: DETAILED 4-6 sentence strategic recommendation. Explain: (1) The primary strategy and WHY it works against this fighter, (2) Secondary approach if primary fails, (3) Key techniques to emphasize and why, (4) What to avoid and why. This should provide clear, actionable guidance.>"
  },

  "fightingStyleBreakdown": {
    "primaryStyle": "<string: BASED ON WHAT YOU SEE IN VIDEO - e.g., 'Wrestler' if they shoot takedowns, 'Pressure Boxer' if they throw punches, 'Grappler' if they work on the ground>",
    "stance": "<string: 'Orthodox' or 'Southpaw' - observe their lead hand/foot>",
    "secondarySkills": ["<string: secondary skill OBSERVED with brief explanation>", "<string>", "<string>"],
    "baseMartialArts": ["<string: martial arts DEMONSTRATED in video - e.g., 'Wrestling', 'Boxing', 'BJJ', 'Muay Thai'>"],
    "styleDescription": "<string: DETAILED 3-4 sentence technical breakdown. Describe their preferred range, rhythm, typical combinations, how they set up attacks, and what makes their style effective or ineffective.>",
    "secondaryAttributes": ["<string: attribute with context - e.g., 'Elite Cardio - maintained output through round 5'>", "<string>", "<string>"],
    "comparableFighters": ["<string: famous fighter with SIMILAR STYLE - explain briefly why the comparison fits>", "<string>"],
    "tacticalTendencies": ["<string: specific pattern with frequency/timing if observed - e.g., 'Throws lead hook after opponent jabs (seen 6+ times)'>", "<string>", "<string>", "<string>", "<string>"]
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
        "description": "<string: DETAILED 2-3 sentence explanation. Describe HOW they demonstrate this strength, specific examples from the video, and why it makes them dangerous.>",
        "score": <number 0-100>,
        "statistics": "<string or null: relevant stat with context - e.g., 'Landed 8 of 10 counter punches'>"
      }
    ],
    "weaknesses": [
      {
        "title": "<string: weakness name>",
        "description": "<string: DETAILED 2-3 sentence explanation. Describe specific instances where this weakness appeared and the consequences.>",
        "severity": <number 0-100>,
        "exploitablePattern": "<string: DETAILED explanation of how opponents successfully exploited this - include timing and setups>",
        "frequency": "<string or null: how often it occurs with specifics - e.g., 'Every time opponent pressured forward'>",
        "exploitationStrategy": "<string: DETAILED 2-sentence tactical plan to exploit this weakness, including specific techniques and timing>"
      }
    ],
    "opportunitiesToExploit": ["<string: DETAILED opportunity with specific technique and timing to use>", "<string>", "<string>"]
  },

  "mistakePatterns": {
    "patterns": [
      {
        "pattern": "<string: DETAILED description of repeated mistake - include when/why it happens and what opening it creates>",
        "frequency": <integer: times observed>,
        "severity": "<string: 'high', 'medium', or 'low'>",
        "howToExploit": "<string: specific technique and timing to capitalize on this mistake>"
      }
    ]
  },

  "counterStrategy": {
    "bestCounter": {
      "style": "<string: recommended fighting style to use>",
      "reason": "<string: DETAILED 2-3 sentence explanation of WHY this style works. Reference specific weaknesses observed and how this style exploits them.>"
    },
    "secondBestCounter": {
      "style": "<string>",
      "reason": "<string: DETAILED explanation with specific reasoning>"
    },
    "thirdBestCounter": {
      "style": "<string>",
      "reason": "<string: DETAILED explanation with specific reasoning>"
    },
    "techniquesToEmphasize": ["<string: specific technique WITH explanation of why it's effective>", "<string>", "<string>", "<string>"]
  },
${userCentricJsonSchema}
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
REQUIREMENTS - ${roleType.toUpperCase()} MODE
═══════════════════════════════════════════════════════════

${isStudyMode ? `
🔬 STUDY MODE - NEUTRAL ANALYSIS

You are providing an objective, educational breakdown of this fighter.
NO game plans, NO training recommendations, NO personalized coaching.

Focus on describing WHAT you observe, not prescribing what someone should DO.
Use neutral language: "The fighter demonstrates...", "This style is characterized by..."

DO NOT include: gamePlan, midFightAdjustments, trainingRecommendations, keyInsights
` : roleType === 'coach' ? `
🎓 COACH MODE - INSTRUCTIONAL ANALYSIS

You are a coach analyzing this fighter to train your students.
Frame everything from an educational, instructional perspective.

Use instructional language: "Your fighter should...", "Teach them to...", "Focus training on..."
` : `
🥊 FIGHTER MODE - USER-CENTRIC COACHING

All output is for THE USER who uploaded this video.
The USER wants to learn how to fight AGAINST this fighter.

All coaching content should read as "YOU should do X" or "Your goal is Y" - USER-CENTRIC!
`}

SPECIFIC REQUIREMENTS:
${!isStudyMode ? `1. GAME PLANS: Create EXACTLY ${userRounds} roundByRound entries and ${userRounds} roundGamePlans entries (for rounds 1-${userRounds})
2. ` : `1. `}ROUND METRICS: Create EXACTLY ${videoRounds} entries in roundByRoundMetrics.rounds (for rounds 1-${videoRounds} from video)
${!isStudyMode ? `3. ` : `2. `}CARDIO: Create ${videoRounds} roundByRound entries in cardioAnalysis
${!isStudyMode ? `4. ` : `3. `}STRENGTHS: Provide 3-5 strengths with scores - ONLY what you OBSERVED in the video
${!isStudyMode ? `5. ` : `4. `}WEAKNESSES: Provide 3-5 weaknesses with exploitation strategies - ONLY what you OBSERVED
${!isStudyMode ? `6. ` : `5. `}MISTAKES: Provide 3-5 mistake patterns you actually SAW in the video
${!isStudyMode ? `7. ADJUSTMENTS: Provide 5-6 if/then adjustments
8. ` : `6. `}Use the fighter's actual name "${fighterName}" throughout the report
${!isStudyMode ? `9. ` : `7. `}Be specific and actionable in all ${isStudyMode ? 'observations' : 'recommendations'}
${!isStudyMode ? `10. ` : `8. `}All number scores should be realistic (not all 80s - vary them based on actual observation)

═══════════════════════════════════════════════════════════
🏆 PREMIUM QUALITY REQUIREMENT - $19.99 ANALYSIS 🏆
═══════════════════════════════════════════════════════════

This is a PREMIUM paid analysis. Users expect DEEP, DETAILED insights - NOT generic summaries.

EVERY text field should be:
- DETAILED: Multiple sentences with specific observations, not 1-2 line summaries
- SPECIFIC: Reference actual moments, techniques, and patterns observed in the video
- ACTIONABLE: Explain WHY something matters and HOW to use the information
- EXPERT-LEVEL: Sound like advice from a professional fight analyst/coach

❌ BAD (too generic): "Technical striker with good movement"
✅ GOOD (detailed): "Technical counter-striker who excels at controlling distance using a stiff jab and lateral movement. Shows excellent timing on pull-back counters, particularly landing clean right hands when opponents overcommit. However, his reliance on backing straight up under pressure was exploited multiple times, suggesting vulnerability to aggressive cage-cutting."

❌ BAD (too brief): "Pressure wrestling with body shots"
✅ GOOD (detailed): "Your primary strategy should be pressure wrestling combined with body attacks. Close distance using feints and jab entries, then shoot takedowns when he backs up - his takedown defense deteriorates significantly when moving backward. On the feet, target his body with hooks and uppercuts when he shells up, as this will slow his movement and create further takedown opportunities. Avoid standing at range where he's most comfortable counter-striking."

Every section should demonstrate this level of depth and specificity.

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
  console.log(`Analysis started at: ${new Date().toISOString()}`);

  // Create AbortController for timeout (12 minutes max for video analysis)
  // Must support 30-min videos with up to 100 frames as advertised
  // Claude processing time scales with frame count: ~6 sec/frame + overhead
  const controller = new AbortController();
  const timeoutMs = 12 * 60 * 1000; // 12 minutes
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.error(`Claude API call timed out after 12 minutes (${frameCount} frames)`);
  }, timeoutMs);

  let response;
  try {
    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      messages: [
        {
          role: 'user',
          content: content,
        },
      ],
    }, {
      signal: controller.signal,
    });
  } catch (apiError) {
    clearTimeout(timeoutId);
    if (apiError.name === 'AbortError') {
      throw new Error('TIMEOUT: Analysis took too long (12+ minutes). Please try again - the AI service may be experiencing high load.');
    }
    // Provide more specific error messages for Claude API errors
    const errorMessage = apiError.message || 'Unknown API error';
    console.error('Claude API error details:', {
      name: apiError.name,
      message: errorMessage,
      status: apiError.status,
      type: apiError.type
    });

    if (apiError.status === 429) {
      throw new Error('API_RATE_LIMIT: The service is temporarily busy. Please try again in a few minutes.');
    } else if (apiError.status === 400) {
      throw new Error('API_BAD_REQUEST: Invalid request to AI service. ' + errorMessage);
    } else if (apiError.status === 500 || apiError.status === 502 || apiError.status === 503) {
      throw new Error('API_SERVICE_ERROR: AI service is temporarily unavailable. Please try again later.');
    } else {
      throw new Error('API_ERROR: ' + errorMessage);
    }
  } finally {
    clearTimeout(timeoutId);
  }

  console.log(`Analysis completed at: ${new Date().toISOString()}`);

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
 * Validate a single fighter's analysis data (used for both fighters mode)
 */
function validateSingleFighterAnalysis(data, fighterName, videoRounds) {
  const ensureArray = (val, defaultArr = []) => Array.isArray(val) ? val : defaultArr;
  const ensureNumber = (val, defaultVal = 0) => {
    if (typeof val === 'number') return val;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? defaultVal : parsed;
  };
  const ensureString = (val, defaultVal = '') => typeof val === 'string' ? val : defaultVal;

  // Fighter Identification
  if (!data.fighterIdentification) {
    data.fighterIdentification = {
      confirmedName: fighterName,
      visualIdentifiers: 'Identified based on description',
      confidenceLevel: 'Medium',
      observedStyle: 'Mixed',
      declaredBackground: 'Not specified',
      styleMismatch: false
    };
  }

  // Executive Summary
  if (!data.executiveSummary) {
    data.executiveSummary = {
      overallScore: 70,
      summary: `Analysis of ${fighterName}`,
      keyFindings: ['Analysis data available'],
      recommendedApproach: 'See detailed analysis'
    };
  }

  // Fighting Style Breakdown
  if (!data.fightingStyleBreakdown) {
    data.fightingStyleBreakdown = {
      primaryStyle: 'Mixed Martial Artist',
      stance: 'Orthodox',
      secondarySkills: [],
      baseMartialArts: ['MMA'],
      styleDescription: `${fighterName} shows mixed martial arts abilities.`,
      secondaryAttributes: [],
      comparableFighters: [],
      tacticalTendencies: []
    };
  }

  // Strike Analysis
  if (!data.strikeAnalysis) {
    data.strikeAnalysis = {
      accuracy: 50, volume: 0, powerScore: 50, techniqueScore: 50,
      breakdown: { jabs: 0, crosses: 0, hooks: 0, uppercuts: 0, kicks: 0, knees: 0, elbows: 0 },
      patterns: [], recommendations: []
    };
  }

  // Grappling Analysis
  if (!data.grapplingAnalysis) {
    data.grapplingAnalysis = {
      takedownAccuracy: 50, takedownDefense: 50, controlTime: 0, submissionAttempts: 0,
      techniques: [], recommendations: []
    };
  }

  // Defense Analysis
  if (!data.defenseAnalysis) {
    data.defenseAnalysis = {
      headMovement: 50, footwork: 50, blockingRate: 50, counterStrikeRate: 50,
      vulnerabilities: [], improvements: []
    };
  }

  // Cardio Analysis
  if (!data.cardioAnalysis) {
    data.cardioAnalysis = {
      roundByRound: [],
      overallStamina: 70,
      fatigueIndicators: [],
      recommendations: []
    };
  }
  if (!data.cardioAnalysis.roundByRound || data.cardioAnalysis.roundByRound.length === 0) {
    data.cardioAnalysis.roundByRound = [];
    for (let i = 1; i <= videoRounds; i++) {
      data.cardioAnalysis.roundByRound.push({
        roundNumber: i, outputLevel: 80, staminaScore: 80, notes: `Round ${i}`
      });
    }
  }

  // Fight IQ
  if (!data.fightIQ) {
    data.fightIQ = {
      overallScore: 70, decisionMaking: 70, adaptability: 70, strategyExecution: 70,
      keyObservations: [], improvements: []
    };
  }

  // Strengths and Weaknesses
  if (!data.strengthsWeaknesses) {
    data.strengthsWeaknesses = {
      strengths: [{ title: 'To be analyzed', description: 'See details', score: 70, statistics: null }],
      weaknesses: [{ title: 'To be analyzed', description: 'See details', severity: 50, exploitablePattern: '', frequency: null, exploitationStrategy: '' }],
      opportunitiesToExploit: []
    };
  }

  // Mistake Patterns
  if (!data.mistakePatterns) {
    data.mistakePatterns = { patterns: [] };
  }

  // Counter Strategy
  if (!data.counterStrategy) {
    data.counterStrategy = {
      bestCounter: { style: 'Balanced approach', reason: 'Adapt based on opponent' },
      secondBestCounter: { style: 'Pressure fighting', reason: 'Test their cardio' },
      thirdBestCounter: { style: 'Counter striking', reason: 'Exploit openings' },
      techniquesToEmphasize: []
    };
  }

  // Round by Round Metrics
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

  return data;
}

/**
 * Validate and fix analysis data to match iOS AnalysisReport model exactly
 * Adds default values for missing optional fields, ensures correct types
 * Handles role-based sections (study mode may not have game plans, etc.)
 */
function validateAndFixAnalysisData(data, config) {
  const userRounds = config.userFightRounds || 3;
  const videoRounds = config.videoRounds || 3;
  const roleType = getUserRoleType(config.userRole);
  const isStudyMode = roleType === 'study';

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

  // HANDLE BOTH FIGHTERS MODE
  if (config.analysisType === 'both') {
    console.log('Processing BOTH FIGHTERS mode data...');

    // Ensure fighter1Analysis exists
    if (!data.fighter1Analysis) {
      data.fighter1Analysis = {};
    }
    // Ensure fighter2Analysis exists
    if (!data.fighter2Analysis) {
      data.fighter2Analysis = {};
    }
    // Ensure matchupAnalysis exists
    if (!data.matchupAnalysis) {
      data.matchupAnalysis = {
        summary: 'Matchup analysis not available',
        keyMatchups: [],
        criticalMoments: [],
        opponentPreparation: {
          keyDangers: [],
          tacticalAdjustments: [],
          preparationGuidance: [],
          similarStyleGuidance: null
        }
      };
    }
    // Migrate old prediction format to new opponentPreparation format
    if (data.matchupAnalysis && !data.matchupAnalysis.opponentPreparation) {
      data.matchupAnalysis.opponentPreparation = {
        keyDangers: [],
        tacticalAdjustments: [],
        preparationGuidance: [],
        similarStyleGuidance: null
      };
      // Remove old prediction fields if they exist
      delete data.matchupAnalysis.predictedWinner;
      delete data.matchupAnalysis.winProbability;
      delete data.matchupAnalysis.likelyOutcome;
      delete data.matchupAnalysis.predictionReasoning;
    }

    // If Claude returned data at top level instead of in fighter objects, copy it to fighter1Analysis
    // This handles cases where Claude doesn't follow the nested structure perfectly
    const topLevelFields = ['executiveSummary', 'fightingStyleBreakdown', 'strikeAnalysis',
      'grapplingAnalysis', 'defenseAnalysis', 'cardioAnalysis', 'fightIQ',
      'strengthsWeaknesses', 'mistakePatterns', 'counterStrategy', 'fighterIdentification'];

    topLevelFields.forEach(field => {
      // If top-level has data but fighter1Analysis doesn't, copy it
      if (data[field] && !data.fighter1Analysis[field]) {
        console.log(`Copying top-level ${field} to fighter1Analysis`);
        data.fighter1Analysis[field] = data[field];
      }
    });

    // Validate fighter1Analysis
    data.fighter1Analysis = validateSingleFighterAnalysis(data.fighter1Analysis, config.fighter1Name || 'Fighter 1', videoRounds);

    // Validate fighter2Analysis
    data.fighter2Analysis = validateSingleFighterAnalysis(data.fighter2Analysis, config.fighter2Name || 'Fighter 2', videoRounds);

    // Ensure shared sections exist at top level for iOS compatibility (skip for study mode)
    // Game Plan, Adjustments, Training, KeyInsights are shared between fighters
    const roleType = getUserRoleType(config.userRole);
    const isStudyMode = roleType === 'study';

    if (!data.gamePlan) {
      if (isStudyMode) {
        data.gamePlan = null;
      } else {
        data.gamePlan = {
          overallStrategy: 'Implement a balanced game plan.',
          roundByRound: [],
          roundGamePlans: [],
          keyTactics: [],
          thingsToAvoid: []
        };
        // Generate default game plans for user rounds
        for (let i = 1; i <= userRounds; i++) {
          data.gamePlan.roundByRound.push({
            roundNumber: i,
            objective: `Round ${i} objective`,
            tactics: ['Stay focused', 'Execute game plan'],
            keyFocus: 'Maintain composure'
          });
          data.gamePlan.roundGamePlans.push({
            roundNumber: i,
            title: `Round ${i} Strategy`,
            planA: { name: 'Primary Plan', goal: 'Execute strategy', tactics: ['Stay focused'], successIndicators: ['Landing strikes'], switchTrigger: 'If not working' },
            planB: { name: 'Backup Plan', goal: 'Adjust approach', tactics: ['Change rhythm'], successIndicators: ['Creating openings'], switchTrigger: 'If needed' },
            planC: { name: 'Emergency Plan', goal: 'Survive and recover', tactics: ['Clinch and control'], successIndicators: ['Regaining composure'], switchTrigger: null }
          });
        }
      }
    }

    if (!data.midFightAdjustments) {
      data.midFightAdjustments = isStudyMode ? null : { adjustments: [] };
    }

    if (!data.trainingRecommendations) {
      data.trainingRecommendations = isStudyMode ? null : {
        priorityDrills: [],
        sparringFocus: [],
        conditioning: []
      };
    }

    if (!data.keyInsights) {
      data.keyInsights = isStudyMode ? null : {
        criticalObservations: [],
        winConditions: [],
        riskFactors: [],
        finalRecommendation: 'Focus on your strengths and stay disciplined.',
        confidenceLevel: 'Medium'
      };
    }

    console.log('Both fighters validation complete.');
    console.log('Fighter1 strengthsWeaknesses:', JSON.stringify(data.fighter1Analysis.strengthsWeaknesses, null, 2));
    console.log('Fighter2 strengthsWeaknesses:', JSON.stringify(data.fighter2Analysis.strengthsWeaknesses, null, 2));
    return data;
  }

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

  // Validate gamePlan (skip population for study mode)
  if (!data.gamePlan) {
    if (isStudyMode) {
      // Study mode: minimal/null game plan
      data.gamePlan = null;
    } else {
      data.gamePlan = {
        overallStrategy: 'Implement a balanced game plan.',
        roundByRound: [],
        roundGamePlans: [],
        keyTactics: [],
        thingsToAvoid: []
      };
    }
  }
  // Ensure roundByRound has correct number of entries (only if not study mode)
  if (!isStudyMode && data.gamePlan) {
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
    // Convert legacy string thingsToAvoid to new object format
    if (data.gamePlan.thingsToAvoid && Array.isArray(data.gamePlan.thingsToAvoid)) {
      data.gamePlan.thingsToAvoid = data.gamePlan.thingsToAvoid.map(item => {
        // If already in new format, return as-is
        if (typeof item === 'object' && item.avoidance) {
          return {
            avoidance: ensureString(item.avoidance, 'Unknown avoidance'),
            reason: ensureString(item.reason, 'This pattern was identified as a vulnerability based on video analysis.'),
            alternative: ensureString(item.alternative, 'Adjust your approach based on opponent reaction and reset when necessary.')
          };
        }
        // Convert legacy string format to new object format
        if (typeof item === 'string') {
          return {
            avoidance: item,
            reason: 'This pattern was identified as a vulnerability based on video analysis.',
            alternative: 'Adjust your approach based on opponent reaction and reset when necessary.'
          };
        }
        return item;
      });
    }
  }

  // Validate midFightAdjustments (skip for study mode)
  if (!data.midFightAdjustments) {
    if (isStudyMode) {
      data.midFightAdjustments = null;
    } else {
      data.midFightAdjustments = { adjustments: [] };
    }
  }
  if (!isStudyMode && data.midFightAdjustments) {
    data.midFightAdjustments.adjustments = ensureArray(data.midFightAdjustments.adjustments, []).map(a => ({
      ifCondition: ensureString(a.ifCondition, 'If opponent adjusts'),
      thenAction: ensureString(a.thenAction, 'Then counter-adjust')
    }));
  }

  // Validate trainingRecommendations (skip for study mode)
  if (!data.trainingRecommendations) {
    if (isStudyMode) {
      data.trainingRecommendations = null;
    } else {
      data.trainingRecommendations = {
        priorityDrills: [],
        sparringFocus: [],
        conditioning: []
      };
    }
  }

  // Validate keyInsights (skip for study mode)
  if (!data.keyInsights) {
    if (isStudyMode) {
      data.keyInsights = null;
    } else {
      data.keyInsights = {
        criticalObservations: [],
        winConditions: [],
        riskFactors: [],
        finalRecommendation: 'Focus on your strengths and stay disciplined.',
        confidenceLevel: 'Medium'
      };
    }
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
    version: '2.1.0',
    endpoints: {
      analyze: 'POST /analyze',
      getAnalysis: 'GET /analysis/:id',
      status: 'GET /api/analysis/status/:id',
      health: 'GET /health',
      test: 'GET /test-report'
    }
  });
});

/**
 * Dedicated Health Check - Use to warm up server before uploads
 * GET /health
 *
 * Returns: { status: 'ready', timestamp, uptime }
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ready',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
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
      thingsToAvoid: [
        {
          avoidance: "Standing in the pocket and trading",
          reason: "Opponent has faster hands and better timing - prolonged exchanges at boxing range will accumulate damage",
          alternative: "Close distance into clinch range or reset to outside range. Use feints before level changes for takedowns."
        }
      ]
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
        // Always refund credit on server-side failures
        stored.shouldRefund = true;
        stored.refundReason = err.message.includes('TIMEOUT')
          ? 'Analysis timed out - please try with a shorter video'
          : 'Server error during analysis';
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

  const startTime = Date.now();
  const logMemory = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  try {
    // Update progress - starting analysis
    stored.progress = 10;
    analysisStore.set(analysisId, stored);

    // Calculate total frame data size
    const totalFrameSize = frames.reduce((sum, f) => sum + f.buffer.byteLength, 0);
    const frameSizeMB = (totalFrameSize / (1024 * 1024)).toFixed(2);

    console.log(`=== ANALYSIS START: ${analysisId} ===`);
    console.log(`Frames: ${frames.length}, Total size: ${frameSizeMB}MB, Memory: ${logMemory()}MB`);
    console.log(`Config: ${config.analysisType}, Fighter: ${config.fighter1Name || 'N/A'}`);

    // Update progress
    stored.progress = 30;
    analysisStore.set(analysisId, stored);

    // Call Claude API with frames directly
    console.log(`Calling Claude API... (Memory: ${logMemory()}MB)`);
    const analysisData = await analyzeWithClaude(frames, config);
    console.log(`Claude API returned (Memory: ${logMemory()}MB, Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s)`);

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

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`=== ANALYSIS COMPLETE: ${analysisId} ===`);
    console.log(`Total time: ${totalTime}s, Final memory: ${logMemory()}MB`);

  } catch (error) {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`=== ANALYSIS FAILED: ${analysisId} ===`);
    console.error(`Failed after ${totalTime}s, Memory: ${logMemory()}MB`);
    console.error(`Error type: ${error.name}, Message: ${error.message}`);
    stored.status = 'failed';
    stored.error = error.message;
    // Always refund credit on server-side failures
    stored.shouldRefund = true;

    // Provide user-friendly refund reason based on error type
    if (error.message.includes('TIMEOUT')) {
      stored.refundReason = 'Analysis timed out - please try with a shorter video or fewer frames';
    } else if (error.message.includes('API_RATE_LIMIT')) {
      stored.refundReason = 'Service temporarily busy - please try again in a few minutes';
    } else if (error.message.includes('API_SERVICE_ERROR')) {
      stored.refundReason = 'AI service temporarily unavailable - please try again later';
    } else if (error.message.includes('API_BAD_REQUEST')) {
      stored.refundReason = 'Invalid video format - please ensure the video is valid';
    } else if (error.message.includes('JSON')) {
      stored.refundReason = 'Analysis response was invalid - please try again';
    } else {
      stored.refundReason = 'Server error during analysis - please try again';
    }

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

  const response = {
    status: statusMap[stored.status] || stored.status,
    progress: stored.progress,
    message: stored.status === 'completed'
      ? 'Analysis complete'
      : stored.status === 'failed'
        ? stored.error || 'Analysis failed'
        : 'Analysis in progress'
  };

  // Include refund information if analysis failed
  if (stored.status === 'failed') {
    response.shouldRefund = stored.shouldRefund || false;
    response.refundReason = stored.refundReason || null;
    response.error = stored.error || 'Analysis failed';
  }

  res.json(response);
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
