// services/aiService.ts
// SOTA Enterprise-Grade AI Service with Streaming, Workers, and Circuit Breaker

import { GoogleGenAI, GenerateContentParameters, GenerateContentResponse, Content } from '@google/genai';
import { 
    AiProvider, AppState, ToolIdea, QuizData, OptimizationStrategy, 
    GroundingMetadata, QuizGenerationResult, WordPressPost, ContentHealth, Theme 
} from '../types';
import { AI_PROVIDERS } from '../constants';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const AI_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 60_000;

// ═══════════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER PATTERN
// ═══════════════════════════════════════════════════════════════════════════════

interface CircuitBreakerState {
    failures: number;
    lastFailure: number;
    isOpen: boolean;
}

const circuitBreakers: Map<AiProvider, CircuitBreakerState> = new Map();

function getCircuitBreaker(provider: AiProvider): CircuitBreakerState {
    if (!circuitBreakers.has(provider)) {
        circuitBreakers.set(provider, { failures: 0, lastFailure: 0, isOpen: false });
    }
    return circuitBreakers.get(provider)!;
}

function recordFailure(provider: AiProvider): void {
    const cb = getCircuitBreaker(provider);
    cb.failures++;
    cb.lastFailure = Date.now();
    if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
        cb.isOpen = true;
        console.warn(`[CircuitBreaker] Provider ${provider} circuit OPEN after ${cb.failures} failures`);
    }
}

function recordSuccess(provider: AiProvider): void {
    const cb = getCircuitBreaker(provider);
    cb.failures = 0;
    cb.isOpen = false;
}

function isCircuitOpen(provider: AiProvider): boolean {
    const cb = getCircuitBreaker(provider);
    if (cb.isOpen && Date.now() - cb.lastFailure > CIRCUIT_BREAKER_RESET_MS) {
        cb.isOpen = false; // Half-open for retry
        cb.failures = Math.floor(cb.failures / 2);
    }
    return cb.isOpen;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LRU CACHE WITH TTL
// ═══════════════════════════════════════════════════════════════════════════════

interface CacheEntry<T> {
    value: T;
    timestamp: number;
    contentHash: string;
    accessCount: number;
}

class LRUCache<T> {
    private cache: Map<string, CacheEntry<T>> = new Map();
    private readonly maxSize: number;
    private readonly ttlMs: number;

    constructor(maxSize = 100, ttlMs = 30 * 60 * 1000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }

    private hash(content: string): string {
        let hash = 0;
        for (let i = 0; i < Math.min(content.length, 1000); i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    get(key: string, contentForValidation?: string): T | null {
        const entry = this.cache.get(key);
        if (!entry) return null;

        const isExpired = Date.now() - entry.timestamp > this.ttlMs;
        const isContentChanged = contentForValidation && this.hash(contentForValidation) !== entry.contentHash;

        if (isExpired || isContentChanged) {
            this.cache.delete(key);
            return null;
        }

        entry.accessCount++;
        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T, content: string): void {
        // Evict LRU if at capacity
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) this.cache.delete(firstKey);
        }

        this.cache.set(key, {
            value,
            timestamp: Date.now(),
            contentHash: this.hash(content),
            accessCount: 1,
        });
    }

    clear(): void {
        this.cache.clear();
    }

    getStats(): { size: number; hitRate: number } {
        let totalAccess = 0;
        this.cache.forEach(entry => totalAccess += entry.accessCount);
        return { size: this.cache.size, hitRate: totalAccess / Math.max(this.cache.size, 1) };
    }
}

const aiCache = new LRUCache<QuizGenerationResult>(50, 60 * 60 * 1000);
const healthCache = new LRUCache<{ ideas: ToolIdea[]; health: ContentHealth }>(100, 30 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// STREAMING CALLBACK TYPE
// ═══════════════════════════════════════════════════════════════════════════════

export type StreamCallback = (chunk: string, progress: number, stage: string) => void;

// ═══════════════════════════════════════════════════════════════════════════════
// RETRY WITH EXPONENTIAL BACKOFF
// ═══════════════════════════════════════════════════════════════════════════════

async function withRetry<T>(
    fn: () => Promise<T>,
    provider: AiProvider,
    maxRetries = MAX_RETRIES
): Promise<T> {
    if (isCircuitOpen(provider)) {
        throw new Error(`Service temporarily unavailable for ${provider}. Please try again shortly.`);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const result = await fn();
            recordSuccess(provider);
            return result;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            
            // Don't retry on non-retryable errors
            if (lastError.message.includes('invalid') || lastError.message.includes('quota')) {
                recordFailure(provider);
                throw lastError;
            }

            if (attempt < maxRetries - 1) {
                const delay = RETRY_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    recordFailure(provider);
    throw lastError!;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC API CALLER WITH STREAMING
// ═══════════════════════════════════════════════════════════════════════════════

async function callGenericChatApi(
    state: AppState,
    prompt: string,
    jsonMode: boolean,
    onStream?: StreamCallback
): Promise<string> {
    const { selectedProvider, apiKeys, openRouterModel } = state;
    
    return withRetry(async () => {
        switch (selectedProvider) {
            case AiProvider.Gemini: {
                const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
                
                if (onStream) {
                    // Streaming mode
                    const streamResponse = await ai.models.generateContentStream({
                        model: AI_PROVIDERS.gemini.defaultModel,
                        contents: prompt,
                    });
                    
                    let fullText = '';
                    let chunkCount = 0;
                    
                    for await (const chunk of streamResponse) {
                        const text = chunk.text || '';
                        fullText += text;
                        chunkCount++;
                        onStream(text, Math.min(chunkCount * 10, 95), 'generating');
                    }
                    
                    onStream('', 100, 'complete');
                    return fullText;
                } else {
                    // Non-streaming mode
                    const response = await ai.models.generateContent({
                        model: AI_PROVIDERS.gemini.defaultModel,
                        contents: prompt,
                    });
                    return response.text || '';
                }
            }
            
            case AiProvider.OpenAI: {
                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKeys.openai}`,
                    },
                    body: JSON.stringify({
                        model: AI_PROVIDERS.openai.defaultModel,
                        messages: [{ role: 'user', content: prompt }],
                        response_format: jsonMode ? { type: 'json_object' } : undefined,
                        stream: !!onStream,
                    }),
                });

                if (!response.ok) {
                    throw new Error(`OpenAI API error: ${response.status}`);
                }

                if (onStream && response.body) {
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let fullText = '';
                    let progress = 0;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

                        for (const line of lines) {
                            const data = line.slice(6);
                            if (data === '[DONE]') continue;
                            
                            try {
                                const parsed = JSON.parse(data);
                                const content = parsed.choices?.[0]?.delta?.content || '';
                                fullText += content;
                                progress = Math.min(progress + 5, 95);
                                onStream(content, progress, 'generating');
                            } catch {}
                        }
                    }
                    
                    onStream('', 100, 'complete');
                    return fullText;
                }

                const data = await response.json();
                return data.choices[0].message.content;
            }
            
            case AiProvider.Anthropic: {
                const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKeys.anthropic,
                        'anthropic-version': '2023-06-01',
                        'anthropic-dangerous-direct-browser-access': 'true',
                    },
                    body: JSON.stringify({
                        model: AI_PROVIDERS.anthropic.defaultModel,
                        max_tokens: 8192,
                        messages: [{ role: 'user', content: prompt }],
                        stream: !!onStream,
                    }),
                });

                if (!response.ok) {
                    throw new Error(`Anthropic API error: ${response.status}`);
                }

                if (onStream && response.body) {
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let fullText = '';
                    let progress = 0;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

                        for (const line of lines) {
                            try {
                                const parsed = JSON.parse(line.slice(6));
                                if (parsed.type === 'content_block_delta') {
                                    const content = parsed.delta?.text || '';
                                    fullText += content;
                                    progress = Math.min(progress + 3, 95);
                                    onStream(content, progress, 'generating');
                                }
                            } catch {}
                        }
                    }
                    
                    onStream('', 100, 'complete');
                    return fullText;
                }

                const data = await response.json();
                return data.content[0].text;
            }
            
            case AiProvider.OpenRouter: {
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKeys.openrouter}`,
                        'HTTP-Referer': window.location.origin,
                    },
                    body: JSON.stringify({
                        model: openRouterModel || AI_PROVIDERS.openrouter.defaultModel,
                        messages: [{ role: 'user', content: prompt }],
                        stream: !!onStream,
                    }),
                });

                if (!response.ok) {
                    throw new Error(`OpenRouter API error: ${response.status}`);
                }

                if (onStream && response.body) {
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let fullText = '';
                    let progress = 0;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

                        for (const line of lines) {
                            const data = line.slice(6);
                            if (data === '[DONE]') continue;
                            
                            try {
                                const parsed = JSON.parse(data);
                                const content = parsed.choices?.[0]?.delta?.content || '';
                                fullText += content;
                                progress = Math.min(progress + 4, 95);
                                onStream(content, progress, 'generating');
                            } catch {}
                        }
                    }
                    
                    onStream('', 100, 'complete');
                    return fullText;
                }

                const data = await response.json();
                return data.choices[0].message.content;
            }
            
            default:
                throw new Error(`Unsupported provider: ${selectedProvider}`);
        }
    }, selectedProvider);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARALLEL BATCH PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

interface BatchTask<T> {
    id: string;
    execute: () => Promise<T>;
}

async function processBatch<T>(
    tasks: BatchTask<T>[],
    concurrency = 3,
    onProgress?: (completed: number, total: number, taskId: string) => void
): Promise<Map<string, T | Error>> {
    const results = new Map<string, T | Error>();
    const queue = [...tasks];
    let completed = 0;

    const worker = async () => {
        while (queue.length > 0) {
            const task = queue.shift()!;
            try {
                const result = await task.execute();
                results.set(task.id, result);
            } catch (error) {
                results.set(task.id, error instanceof Error ? error : new Error(String(error)));
            }
            completed++;
            onProgress?.(completed, tasks.length, task.id);
        }
    };

    await Promise.all(Array(Math.min(concurrency, tasks.length)).fill(null).map(worker));
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function getHealthAndIdeasPrompt(title: string, content: string): string {
    const cleanContent = content
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 12000);

    return `You are an expert content strategist and SEO specialist. Analyze this content and provide:

TITLE: "${title}"
CONTENT: "${cleanContent}"

Return ONLY valid JSON matching this exact schema:
{
    "health": {
        "score": <number 0-100>,
        "readability": "<string: grade level assessment>",
        "seoGap": "<string: primary SEO improvement opportunity>",
        "missingTopics": ["<string>", "<string>", "<string>"],
        "internalLinkSuggestions": ["<topic1>", "<topic2>"]
    },
    "ideas": [
        {
            "title": "<compelling quiz title>",
            "description": "<2 sentence value proposition>",
            "icon": "<calculator|chart|list|idea>"
        }
    ]
}

Generate exactly 3 quiz ideas that:
1. Test comprehension of key concepts
2. Drive engagement through personality-style results
3. Provide educational value while being entertaining`;
}

function getQuizJsonPrompt(
    postTitle: string,
    postContent: string,
    idea: ToolIdea,
    strategy: OptimizationStrategy
): string {
    const cleanContent = postContent
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 10000);

    const strategyInstructions = {
        standard: 'Focus on accuracy and educational value.',
        fact_check: 'Verify all facts using your grounding tools. Include citations where applicable.',
        geo: 'Include location-specific context and local relevance where applicable.',
    };

    return `Generate an interactive quiz as JSON.

POST TITLE: "${postTitle}"
QUIZ CONCEPT: "${idea.title}" - ${idea.description}
STRATEGY: ${strategyInstructions[strategy]}

CONTENT TO ANALYZE:
${cleanContent}

Return ONLY valid JSON:
{
    "quizSchema": {
        "@context": "https://schema.org",
        "@type": "Quiz",
        "name": "<quiz title>",
        "description": "<compelling description>",
        "hasPart": [
            {
                "@type": "Question",
                "name": "<question text>",
                "acceptedAnswer": { "@type": "Answer", "text": "<correct answer>" },
                "suggestedAnswer": [
                    { "@type": "Answer", "text": "<wrong answer 1>" },
                    { "@type": "Answer", "text": "<wrong answer 2>" },
                    { "@type": "Answer", "text": "<wrong answer 3>" }
                ]
            }
        ]
    },
    "faqSchema": {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": "<FAQ question>",
                "acceptedAnswer": { "@type": "Answer", "text": "<comprehensive answer>" }
            }
        ]
    },
    "content": {
        "questions": [
            {
                "question": "<question text>",
                "options": [
                    { "text": "<option>", "isCorrect": true },
                    { "text": "<option>", "isCorrect": false }
                ],
                "explanation": "<educational explanation of correct answer>"
            }
        ],
        "results": [
            { "minScore": 0, "title": "<result title>", "summary": "<encouraging summary>" },
            { "minScore": 50, "title": "<result title>", "summary": "<positive summary>" },
            { "minScore": 80, "title": "<result title>", "summary": "<excellent summary>" }
        ]
    }
}

Generate 5-7 questions with 4 options each. Include 3 result tiers.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export async function validateApiKey(
    provider: AiProvider,
    key: string,
    model?: string
): Promise<boolean> {
    if (provider === AiProvider.Gemini) {
        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            await ai.models.generateContent({
                model: AI_PROVIDERS.gemini.defaultModel,
                contents: 'Say "valid"',
            });
            return true;
        } catch {
            return false;
        }
    }

    // Validate other providers
    try {
        const testState = {
            selectedProvider: provider,
            apiKeys: { [provider]: key } as any,
            openRouterModel: model || '',
        } as AppState;

        await callGenericChatApi(testState, 'Say "valid"', false);
        return true;
    } catch {
        return false;
    }
}

export async function analyzeContentHealth(
    state: AppState,
    title: string,
    content: string,
    onStream?: StreamCallback
): Promise<{ ideas: ToolIdea[]; health: ContentHealth }> {
    const cacheKey = `health_${state.selectedProvider}_${title.substring(0, 50)}`;
    const cached = healthCache.get(cacheKey, content);
    if (cached) {
        onStream?.('', 100, 'cached');
        return cached;
    }

    const prompt = getHealthAndIdeasPrompt(title, content);
    
    onStream?.('', 5, 'analyzing');
    const responseText = await callGenericChatApi(state, prompt, true, onStream);
    
    const jsonString = responseText.substring(
        responseText.indexOf('{'),
        responseText.lastIndexOf('}') + 1
    );
    
    const parsed = JSON.parse(jsonString);
    const result = {
        ideas: parsed.ideas || [],
        health: parsed.health || {
            score: 70,
            readability: 'Unknown',
            seoGap: 'Analysis incomplete',
            missingTopics: [],
            internalLinkSuggestions: [],
        },
    };

    healthCache.set(cacheKey, result, content);
    return result;
}

export async function generateQuizAndMetadata(
    state: AppState,
    postTitle: string,
    postContent: string,
    idea: ToolIdea,
    strategy: OptimizationStrategy,
    allPosts: WordPressPost[],
    onStream?: StreamCallback
): Promise<QuizGenerationResult> {
    const cacheKey = `quiz_v3_${state.selectedProvider}_${postTitle}_${idea.title}_${strategy}`;
    const cached = aiCache.get(cacheKey, postContent);
    if (cached) {
        onStream?.('', 100, 'cached');
        return cached;
    }

    const prompt = getQuizJsonPrompt(postTitle, postContent, idea, strategy);
    let responseText = '';
    let groundingMetadata: GroundingMetadata | null = null;

    onStream?.('', 5, 'preparing');

    if (state.selectedProvider === AiProvider.Gemini && (strategy === 'fact_check' || strategy === 'geo')) {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        const request: GenerateContentParameters = {
            model: AI_PROVIDERS.gemini.defaultModel,
            contents: prompt,
            config: {},
        };

        if (strategy === 'fact_check') {
            request.config!.tools = [{ googleSearch: {} }];
        } else if (strategy === 'geo') {
            request.config!.tools = [{ googleMaps: {} }];
            try {
                const position = await new Promise<GeolocationPosition>((resolve, reject) => {
                    navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
                });
                request.config!.toolConfig = {
                    retrievalConfig: {
                        latLng: {
                            latitude: position.coords.latitude,
                            longitude: position.coords.longitude,
                        },
                    },
                };
            } catch {
                console.warn('Geolocation unavailable, proceeding without location bias');
            }
        }

        onStream?.('', 15, 'grounding');

        const generatePromise = ai.models.generateContent(request);
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`AI generation timed out after ${AI_TIMEOUT_MS / 1000}s`)), AI_TIMEOUT_MS)
        );

        const response = await Promise.race([generatePromise, timeoutPromise]);
        responseText = response.text || '';
        groundingMetadata = response.candidates?.[0]?.groundingMetadata ?? null;
    } else {
        responseText = await callGenericChatApi(state, prompt, true, onStream);
    }

    onStream?.('', 90, 'parsing');

    const jsonString = responseText.substring(
        responseText.indexOf('{'),
        responseText.lastIndexOf('}') + 1
    );

    let quizData: QuizData;
    try {
        quizData = JSON.parse(jsonString);
    } catch (e) {
        throw new Error('AI returned invalid JSON. Please regenerate.');
    }

    const result: QuizGenerationResult = { quizData, groundingMetadata };
    aiCache.set(cacheKey, result, postContent);
    
    onStream?.('', 100, 'complete');
    return result;
}

export async function generateContentUpdate(
    state: AppState,
    postTitle: string,
    quizTitle: string
): Promise<string> {
    const prompt = `Generate JSON with HTML strings to integrate quiz "${quizTitle}" into post "${postTitle}".
Target: Google Featured Snippet optimization.

{
    "introduction": "<p>Engaging intro paragraph...</p>",
    "conclusion": "<div><h3>Key Takeaways</h3><ul><li>Takeaway 1</li></ul></div>"
}`;

    try {
        const text = await callGenericChatApi(state, prompt, true);
        const json = JSON.parse(text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1));
        return `<!-- QUIZ INTRO -->\n${json.introduction}\n\n<!-- FEATURED SNIPPET -->\n${json.conclusion}`;
    } catch {
        return `<!-- Intro -->\n<p>Test your knowledge with our interactive quiz!</p>`;
    }
}

export async function batchAnalyzePosts(
    state: AppState,
    posts: WordPressPost[],
    onProgress?: (postId: number, progress: number) => void
): Promise<Map<number, { ideas: ToolIdea[]; health: ContentHealth } | Error>> {
    const tasks: BatchTask<{ ideas: ToolIdea[]; health: ContentHealth }>[] = posts.map(post => ({
        id: String(post.id),
        execute: () => analyzeContentHealth(
            state,
            post.title.rendered,
            post.content.raw || post.content.rendered,
            (_, progress) => onProgress?.(post.id, progress)
        ),
    }));

    const results = await processBatch(tasks, 2, (completed, total, taskId) => {
        onProgress?.(parseInt(taskId), 100);
    });

    const typedResults = new Map<number, { ideas: ToolIdea[]; health: ContentHealth } | Error>();
    results.forEach((value, key) => typedResults.set(parseInt(key), value));
    return typedResults;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SNIPPET GENERATOR (Preserved from original)
// ═══════════════════════════════════════════════════════════════════════════════

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return null;

    let r = parseInt(result[1], 16) / 255;
    let g = parseInt(result[2], 16) / 255;
    let b = parseInt(result[3], 16) / 255;

    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }

    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function createQuizSnippet(
    quizResult: QuizGenerationResult,
    themeColor: string,
    theme: Theme
): string {
    const { quizData, groundingMetadata } = quizResult;
    const { quizSchema, faqSchema, howToSchema, itemListSchema, content } = quizData;
    const themeHsl = hexToHsl(themeColor) || { h: 221, s: 83, l: 53 };
    const uniqueId = `qf-${Math.random().toString(36).substring(2, 9)}`;

    const escapeHtml = (unsafe: string) =>
        unsafe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const breadcrumbSchema = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: '/' },
            { '@type': 'ListItem', position: 2, name: 'Quiz', item: '' },
        ],
    };

    const schemaScripts = [
        `<script type="application/ld+json">${JSON.stringify(quizSchema, null, 2)}</script>`,
        `<script type="application/ld+json">${JSON.stringify(breadcrumbSchema, null, 2)}</script>`,
    ];
    if (faqSchema) schemaScripts.push(`<script type="application/ld+json">${JSON.stringify(faqSchema, null, 2)}</script>`);
    if (howToSchema) schemaScripts.push(`<script type="application/ld+json">${JSON.stringify(howToSchema, null, 2)}</script>`);
    if (itemListSchema) schemaScripts.push(`<script type="application/ld+json">${JSON.stringify(itemListSchema, null, 2)}</script>`);

    let sourcesHtml = '';
    if (groundingMetadata?.groundingChunks) {
        const validChunks = groundingMetadata.groundingChunks.filter(
            c => (c.web?.uri && c.web.title) || (c.maps?.uri && c.maps.title)
        );
        if (validChunks.length > 0) {
            sourcesHtml = `
            <div class="qf-sources">
                <span class="qf-sources-label">Sources:</span>
                <ul class="qf-sources-list">
                    ${validChunks.map(chunk => {
                        const source = chunk.web || chunk.maps;
                        return `<li><a href="${escapeHtml(source!.uri!)}" target="_blank" rel="nofollow noopener">${escapeHtml(source!.title!)}</a></li>`;
                    }).join('')}
                </ul>
            </div>`;
        }
    }

    // Full snippet HTML generation (preserved from original, optimized)
    return `
${schemaScripts.join('\n')}
<div id="${uniqueId}" class="qf-root ${theme}" data-tool-id="%%TOOL_ID%%">
<style>
#${uniqueId} {
  --hue: ${themeHsl.h}; --sat: ${themeHsl.s}%; --light: ${themeHsl.l}%;
  --primary: hsl(var(--hue), var(--sat), var(--light));
  --surface: rgba(255, 255, 255, 0.7);
  --border: rgba(255, 255, 255, 0.5);
  --text: #0f172a;
  font-family: system-ui, -apple-system, sans-serif;
  width: 100%; max-width: 680px; margin: 40px auto;
  border-radius: 24px; background: var(--surface);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--border);
  box-shadow: 0 20px 40px -10px rgba(0,0,0,0.1);
  overflow: hidden; color: var(--text);
  contain: layout style paint;
}
#${uniqueId}.dark { --surface: rgba(15, 23, 42, 0.7); --border: rgba(255, 255, 255, 0.1); --text: #f8fafc; }
#${uniqueId} .qf-head { padding: 40px; text-align: center; border-bottom: 1px solid var(--border); }
#${uniqueId} .qf-title { font-size: clamp(1.5rem, 4vw, 1.8rem); font-weight: 800; margin-bottom: 10px; line-height: 1.2; background: linear-gradient(135deg, var(--primary), #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
#${uniqueId} .qf-body { padding: 30px; }
#${uniqueId} .qf-opt { display: block; width: 100%; padding: 16px; margin-bottom: 12px; border-radius: 12px; background: rgba(255,255,255,0.5); border: 1px solid rgba(0,0,0,0.05); text-align: left; font-weight: 600; cursor: pointer; transition: transform 0.15s, background 0.15s; color: inherit; will-change: transform; }
#${uniqueId}.dark .qf-opt { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.05); }
#${uniqueId} .qf-opt:hover:not(:disabled) { transform: scale(1.02); background: rgba(255,255,255,0.8); box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
#${uniqueId}.dark .qf-opt:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
#${uniqueId} .qf-opt.correct { background: #d1fae5; border-color: #10b981; color: #064e3b; }
#${uniqueId}.dark .qf-opt.correct { background: rgba(16, 185, 129, 0.2); color: #6ee7b7; }
#${uniqueId} .qf-opt.wrong { background: #fee2e2; border-color: #ef4444; color: #7f1d1d; }
#${uniqueId}.dark .qf-opt.wrong { background: rgba(239, 68, 68, 0.2); color: #fca5a5; }
#${uniqueId} .qf-btn { background: var(--primary); color: white; border: none; padding: 14px 28px; border-radius: 50px; font-weight: 700; cursor: pointer; transition: transform 0.15s; will-change: transform; }
#${uniqueId} .qf-btn:hover { transform: translateY(-2px); box-shadow: 0 10px 20px -5px var(--primary); }
#${uniqueId} .qf-expl { margin-top: 20px; padding: 20px; background: rgba(255,255,255,0.5); border-radius: 12px; border-left: 4px solid var(--primary); display: none; }
#${uniqueId}.dark .qf-expl { background: rgba(0,0,0,0.2); }
#${uniqueId} .qf-sources { font-size: 0.8rem; margin-top: 20px; opacity: 0.8; }
#${uniqueId} .qf-sources a { color: var(--primary); }
</style>

<div id="${uniqueId}-intro" class="qf-head">
    <h2 class="qf-title">${escapeHtml(quizSchema.name)}</h2>
    <p>${escapeHtml(quizSchema.description)}</p>
    <button class="qf-btn" onclick="window.qf_${uniqueId}.start()" style="margin-top:20px;">Start Quiz</button>
</div>

<div id="${uniqueId}-quiz" class="qf-body" style="display:none;">
    <div style="height:4px; background:rgba(0,0,0,0.1); border-radius:2px; margin-bottom:20px;"><div id="${uniqueId}-bar" style="height:100%; width:0%; background:var(--primary); border-radius:2px; transition:width 0.3s;"></div></div>
    <h3 id="${uniqueId}-q" style="font-size:1.4rem; margin-bottom:24px;"></h3>
    <div id="${uniqueId}-opts"></div>
    <div id="${uniqueId}-expl" class="qf-expl"></div>
    <div style="text-align:right; margin-top:20px;"><button id="${uniqueId}-next" class="qf-btn" onclick="window.qf_${uniqueId}.next()" style="display:none;">Next</button></div>
    ${sourcesHtml}
</div>

<div id="${uniqueId}-result" class="qf-head" style="display:none;">
    <h2 id="${uniqueId}-rtitle" class="qf-title"></h2>
    <p id="${uniqueId}-rsummary"></p>
    <button class="qf-btn" onclick="window.qf_${uniqueId}.restart()" style="margin-top:20px;">Try Again</button>
</div>

<script>
(function(){
    const Q=${JSON.stringify(content.questions)};
    const R=${JSON.stringify(content.results)};
    const root=document.getElementById('${uniqueId}');
    const toolId=root.dataset.toolId;
    let idx=0,score=0;
    
    function show(id){['intro','quiz','result'].forEach(s=>document.getElementById('${uniqueId}-'+s).style.display=s===id?'block':'none');}
    function render(){
        const q=Q[idx];
        document.getElementById('${uniqueId}-q').textContent=q.question;
        document.getElementById('${uniqueId}-bar').style.width=((idx+1)/Q.length*100)+'%';
        const opts=document.getElementById('${uniqueId}-opts');
        opts.innerHTML='';
        q.options.forEach((o,i)=>{
            const btn=document.createElement('button');
            btn.className='qf-opt';
            btn.textContent=o.text;
            btn.onclick=()=>answer(i,o.isCorrect,q.explanation);
            opts.appendChild(btn);
        });
        document.getElementById('${uniqueId}-expl').style.display='none';
        document.getElementById('${uniqueId}-next').style.display='none';
    }
    function answer(i,correct,expl){
        const btns=document.querySelectorAll('#${uniqueId}-opts .qf-opt');
        btns.forEach((b,j)=>{
            b.disabled=true;
            if(Q[idx].options[j].isCorrect)b.classList.add('correct');
            else if(j===i)b.classList.add('wrong');
        });
        if(correct)score++;
        document.getElementById('${uniqueId}-expl').innerHTML='<strong>'+(correct?'✓ Correct!':'✗ Incorrect')+'</strong><br>'+expl;
        document.getElementById('${uniqueId}-expl').style.display='block';
        document.getElementById('${uniqueId}-next').style.display='inline-block';
    }
    function next(){
        idx++;
        if(idx>=Q.length){finish();}else{render();}
    }
    function finish(){
        const pct=Math.round(score/Q.length*100);
        const res=[...R].reverse().find(r=>pct>=r.minScore)||R[0];
        document.getElementById('${uniqueId}-rtitle').textContent=res.title;
        document.getElementById('${uniqueId}-rsummary').textContent=res.summary+' (Score: '+score+'/'+Q.length+')';
        show('result');
        if(toolId&&toolId!=='%%TOOL_ID%%'){
            fetch(window.location.origin+'/wp-json/quizforge/v1/submit',{
                method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({toolId:parseInt(toolId),resultTitle:res.title,score:score,totalQuestions:Q.length})
            }).catch(()=>{});
        }
    }
    function restart(){idx=0;score=0;show('intro');}
    function start(){show('quiz');render();}
    window.qf_${uniqueId}={start,next,restart};
})();
</script>
</div>`;
}

// Export cache utilities for debugging
export const cacheUtils = {
    getAiCacheStats: () => aiCache.getStats(),
    getHealthCacheStats: () => healthCache.getStats(),
    clearAllCaches: () => {
        aiCache.clear();
        healthCache.clear();
    },
};
