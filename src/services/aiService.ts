import { aiLogger } from '../lib/logger';
import { cacheGet, cacheSet, TTL } from '../lib/cache';

// ─── Types ────────────────────────────────────
export interface AiContext {
  userId: string;
  campusId: string;
  role: string;
  campusName?: string;
  userName?: string;
}

export interface AiInsightRequest {
  type: 'MEETING_PREP' | 'SCORING' | 'SUSTAINABILITY' | 'LEADERSHIP_READINESS' | 'RISK_EXPLANATION' | 'DAILY_GUIDANCE' | 'CAMPUS_SUMMARY';
  context: AiContext;
  data: Record<string, any>;
}

export interface AiInsightResponse {
  insight: string;
  recommendations: string[];
  scripture?: string;
  urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
  provider: string;
  cached: boolean;
}

// ─── Provider registry ────────────────────────
type Provider = 'groq' | 'ollama' | 'together' | 'anthropic' | 'fallback';

function detectProvider(): Provider {
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.TOGETHER_API_KEY) return 'together';
  if (process.env.OLLAMA_BASE_URL) return 'ollama';
  return 'fallback';
}

// ─── Prompt builders ──────────────────────────
function buildSystemPrompt(context: AiContext): string {
  return `You are the POLR Platform AI — a Christ-centered ministry intelligence system for Path of Life Recovery, a 501(c)(3) recovery ministry in Louisiana.

Your role: Provide actionable, spiritually grounded insights for recovery ministry operations.
Campus: ${context.campusName || context.campusId}
User Role: ${context.role}
Always: Be concise (2-4 sentences per insight), compassionate, and practical.
Never: Replace professional counseling, make medical claims, or provide generic corporate advice.
Tone: Direct, warm, faith-informed. Ground recommendations in Scripture where appropriate.
Format: Respond ONLY with valid JSON matching the schema provided.`;
}

function buildPrompt(req: AiInsightRequest): string {
  const { type, context, data } = req;

  switch (type) {
    case 'MEETING_PREP':
      return `Meeting preparation request for ${context.campusName}.

Scheduled meeting: ${JSON.stringify(data.meeting)}
Recent attendance: ${data.recentAttendance} members in last 30 days
High-risk members attending: ${data.highRiskCount || 0}
Step focus: ${data.stepFocus || 'General recovery'}

Provide a meeting prep insight. JSON schema:
{"insight": "string (2-3 sentences on what to focus)", "recommendations": ["string x3 - specific action items"], "scripture": "string - one relevant KJV verse with reference", "urgency": "LOW|MEDIUM|HIGH"}`;

    case 'SCORING':
      return `Member scoring analysis for ${context.userName || 'member'} at ${context.campusName}.

Engagement score: ${data.engagementScore}/100
Relapse risk level: ${data.relapseRiskLevel}
Risk signals: ${JSON.stringify(data.signals || [])}
Leadership readiness: ${data.leadershipReady ? 'YES' : 'NO'} (score: ${data.leadershipScore}/100)
Days sober: ${data.daysSober || 'unknown'}

Provide a pastoral scoring insight. JSON:
{"insight": "string (honest pastoral assessment)", "recommendations": ["string x3 - specific next steps for this member"], "scripture": "string - encouraging KJV verse", "urgency": "LOW|MEDIUM|HIGH"}`;

    case 'SUSTAINABILITY':
      return `Campus sustainability analysis for ${context.campusName}.

Overall score: ${data.overallScore}/100
Attendance score: ${data.attendanceScore}/100
Financial score: ${data.financialScore}/100
Leadership score: ${data.leadershipScore}/100
Engagement score: ${data.engagementScore}/100
Current lifecycle stage: ${data.lifecycleStage}
Blockers to next stage: ${JSON.stringify(data.blockers || [])}

Provide sustainability insight. JSON:
{"insight": "string (honest campus health assessment)", "recommendations": ["string x3 - specific improvements"], "urgency": "LOW|MEDIUM|HIGH"}`;

    case 'LEADERSHIP_READINESS':
      return `Leadership readiness evaluation for ${context.userName} at ${context.campusName}.

Current role: ${context.role}
Leadership score: ${data.leadershipScore}/100
Readiness: ${data.ready ? 'READY' : 'NOT READY'}
Gaps: ${JSON.stringify(data.gaps || [])}
Months in ministry: ${data.monthsInMinistry || 0}

JSON: {"insight": "string (honest leadership assessment)", "recommendations": ["string x3 - development steps"], "scripture": "string - leadership verse KJV", "urgency": "LOW"}`;

    case 'RISK_EXPLANATION':
      return `Risk alert explanation for ${context.campusName} leader.

Member: ${data.memberName}
Risk level: ${data.riskLevel}
Signals detected: ${JSON.stringify(data.signals || [])}

Explain the risk signals in plain language and what a leader should do. JSON:
{"insight": "string (explain risk in plain pastoral terms)", "recommendations": ["string x3 - immediate outreach steps"], "urgency": "HIGH"}`;

    case 'DAILY_GUIDANCE':
      return `Daily guidance for ${context.userName || 'member'} at ${context.campusName}.

Role: ${context.role}
Day of week: ${new Date().toLocaleDateString('en-US', { weekday: 'long' })}
Recent activity: ${JSON.stringify(data.recentActivity || {})}

Provide daily ministry guidance. JSON:
{"insight": "string (personalized daily encouragement 2 sentences)", "recommendations": ["string x2 - specific today actions"], "scripture": "string - relevant KJV verse"}`;

    case 'CAMPUS_SUMMARY':
      return `Weekly campus summary for ${context.campusName}.

Members: ${data.memberCount}, Active: ${data.activeMembers}
Attendance (7d): ${data.attendance7d}
High risk: ${data.highRiskCount}
Donations (7d): $${data.donations7d}
Lifecycle: ${data.lifecycleStage}

Provide campus summary intelligence. JSON:
{"insight": "string (2-3 sentence campus health read)", "recommendations": ["string x3 - this week priorities"], "urgency": "LOW|MEDIUM|HIGH"}`;

    default:
      return `Provide a brief recovery ministry insight. JSON: {"insight": "string", "recommendations": ["string"], "urgency": "LOW"}`;
  }
}

// ─── Provider calls ───────────────────────────
async function callGroq(system: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama3-70b-8192',
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callOllama(system: string, prompt: string): Promise<string> {
  const res = await fetch(`${process.env.OLLAMA_BASE_URL || 'http://localhost:11434'}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'llama3',
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      stream: false,
      format: 'json',
    }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}`);
  const data = await res.json();
  return data.message.content;
}

async function callTogether(system: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` },
    body: JSON.stringify({
      model: process.env.TOGETHER_MODEL || 'meta-llama/Llama-3-70b-chat-hf',
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`Together error ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callAnthropic(system: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
  const data = await res.json();
  return data.content[0].text;
}

// ─── Grace fallbacks (no AI key required) ────
const GRACE_FALLBACKS: Record<string, AiInsightResponse> = {
  MEETING_PREP: {
    insight: 'Focus on community and accountability today. Open space for honest sharing and ensure every voice is heard.',
    recommendations: ['Open with the POLR declaration together', 'Ask one person to share a current struggle and one victory', 'Close with prayer and assign this week\'s step partner'],
    scripture: '"Where two or three are gathered together in my name, there am I in the midst of them." — Matthew 18:20 KJV',
    urgency: 'LOW', provider: 'grace_fallback', cached: false,
  },
  SCORING: {
    insight: 'Every score is a snapshot, not a sentence. Use these metrics as a conversation starter, not a judgment.',
    recommendations: ['Schedule a personal check-in this week', 'Review their step progress together', 'Pray with them specifically about their identified struggle'],
    scripture: '"I can do all things through Christ which strengtheneth me." — Philippians 4:13 KJV',
    urgency: 'MEDIUM', provider: 'grace_fallback', cached: false,
  },
  SUSTAINABILITY: {
    insight: 'Sustainable ministry is built on consistent community, not perfect metrics. Keep showing up.',
    recommendations: ['Focus on member retention over new recruitment', 'Diversify donation sources', 'Develop your next leader from within'],
    urgency: 'LOW', provider: 'grace_fallback', cached: false,
  },
  LEADERSHIP_READINESS: {
    insight: 'Leadership in recovery ministry is earned through faithful showing up, not credentials.',
    recommendations: ['Complete all 12 steps with accountability', 'Lead one small group session per month', 'Demonstrate consistent sobriety and service'],
    scripture: '"Not by might, nor by power, but by my spirit, saith the LORD of hosts." — Zechariah 4:6 KJV',
    urgency: 'LOW', provider: 'grace_fallback', cached: false,
  },
  RISK_EXPLANATION: {
    insight: 'This member needs personal outreach now. The data flags a pattern that often precedes relapse.',
    recommendations: ['Call or visit them today personally', 'Connect them with their step sponsor immediately', 'Increase meeting frequency and accountability check-ins'],
    urgency: 'HIGH', provider: 'grace_fallback', cached: false,
  },
  DAILY_GUIDANCE: {
    insight: 'Today is a new mercy. Show up, serve one person, and trust the process.',
    recommendations: ['Attend your scheduled meeting', 'Reach out to your accountability partner'],
    scripture: '"This is the day which the LORD hath made; we will rejoice and be glad in it." — Psalm 118:24 KJV',
    provider: 'grace_fallback', cached: false,
  },
  CAMPUS_SUMMARY: {
    insight: 'Your campus is doing what matters most — creating space for transformation.',
    recommendations: ['Follow up with at-risk members this week', 'Celebrate one recovery milestone publicly', 'Review your sustainability index and identify one lever to improve'],
    urgency: 'LOW', provider: 'grace_fallback', cached: false,
  },
};

// ─── Main AI insight function ─────────────────
export async function generateInsight(req: AiInsightRequest): Promise<AiInsightResponse> {
  const cacheKey = `ai:${req.type}:${req.context.campusId}:${req.context.userId}` as any;

  // Check cache
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...(cached as AiInsightResponse), cached: true };

  const provider = detectProvider();
  const system = buildSystemPrompt(req.context);
  const prompt = buildPrompt(req);

  let rawText = '';
  let usedProvider = provider;

  try {
    if (provider === 'groq') rawText = await callGroq(system, prompt);
    else if (provider === 'anthropic') rawText = await callAnthropic(system, prompt);
    else if (provider === 'together') rawText = await callTogether(system, prompt);
    else if (provider === 'ollama') rawText = await callOllama(system, prompt);
    else throw new Error('No AI provider configured');

    // Parse JSON — strip markdown fences if present
    const clean = rawText.replace(/```json\n?|```\n?/g, '').trim();
    const parsed = JSON.parse(clean);

    const result: AiInsightResponse = {
      insight: parsed.insight || 'Ministry intelligence unavailable.',
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      scripture: parsed.scripture,
      urgency: parsed.urgency || 'LOW',
      provider: usedProvider,
      cached: false,
    };

    await cacheSet(cacheKey, result, TTL.MEDIUM);
    return result;
  } catch (err) {
    aiLogger.warn({ err, provider, type: req.type }, 'AI call failed — using grace fallback');
    return GRACE_FALLBACKS[req.type] || GRACE_FALLBACKS.DAILY_GUIDANCE;
  }
}

// ─── Batch insights (for dashboard load) ─────
export async function generateDashboardInsights(context: AiContext, platformData: {
  scoringData?: any;
  sustainabilityData?: any;
  meetingData?: any;
}): Promise<Record<string, AiInsightResponse>> {
  const results: Record<string, AiInsightResponse> = {};

  const requests: AiInsightRequest[] = [];

  if (platformData.scoringData) {
    requests.push({ type: 'SCORING', context, data: platformData.scoringData });
  }
  if (platformData.sustainabilityData) {
    requests.push({ type: 'SUSTAINABILITY', context, data: platformData.sustainabilityData });
  }
  if (platformData.meetingData) {
    requests.push({ type: 'MEETING_PREP', context, data: platformData.meetingData });
  }

  // Run in parallel with 50ms stagger to avoid rate limits
  await Promise.all(requests.map(async (req, i) => {
    await new Promise((r) => setTimeout(r, i * 50));
    results[req.type] = await generateInsight(req);
  }));

  return results;
}
