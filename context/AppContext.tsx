// context/AppContext.tsx
// SOTA Enterprise-Grade State Management with Selectors, Memoization, and Optimistic Updates

import React, {
    createContext,
    useContext,
    useReducer,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    ReactNode,
} from 'react';
import {
    AppState,
    Status,
    WordPressConfig,
    WordPressPost,
    Theme,
    AiProvider,
    ApiKeys,
    ApiValidationStatuses,
    ToolIdea,
    ContentHealth,
    PostFilter,
    Placement,
    OptimizationStrategy,
    QuizGenerationResult,
} from '../types';
import { AI_PROVIDERS, SHORTCODE_DETECTION_REGEX, SHORTCODE_REMOVAL_REGEX } from '../constants';
import {
    validateApiKey,
    analyzeContentHealth,
    generateQuizAndMetadata,
    generateContentUpdate,
    createQuizSnippet,
    batchAnalyzePosts,
    StreamCallback,
} from '../services/aiService';
import {
    saveDraft,
    saveDraftImmediate,
    getDraft,
    getAllDrafts,
    runMaintenance,
} from '../services/persistenceService';
import {
    checkSetup,
    fetchPosts,
    updatePost,
    deleteCfTool,
    createCfTool,
} from '../services/wordpressService';

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE KEYS
// ═══════════════════════════════════════════════════════════════════════════════

const WP_CONFIG_KEY = 'quizforge_wp_config';
const AI_CONFIG_KEY = 'quizforge_ai_config';
const THEME_KEY = 'quizforge_theme';

// ═══════════════════════════════════════════════════════════════════════════════
// INITIAL STATE
// ═══════════════════════════════════════════════════════════════════════════════

const initialApiKeys: ApiKeys = {
    [AiProvider.Gemini]: '',
    [AiProvider.OpenAI]: '',
    [AiProvider.Anthropic]: '',
    [AiProvider.OpenRouter]: '',
};

const initialApiValidationStatuses: ApiValidationStatuses = {
    [AiProvider.Gemini]: 'idle',
    [AiProvider.OpenAI]: 'idle',
    [AiProvider.Anthropic]: 'idle',
    [AiProvider.OpenRouter]: 'idle',
};

const getInitialTheme = (): Theme => {
    if (typeof window === 'undefined') return 'light';
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const initialState: AppState = {
    status: 'idle',
    error: null,
    deletingPostId: null,
    theme: 'light',
    frameStatus: 'initializing',

    selectedProvider: AiProvider.Gemini,
    apiKeys: initialApiKeys,
    apiValidationStatuses: initialApiValidationStatuses,
    openRouterModel: AI_PROVIDERS[AiProvider.OpenRouter].defaultModel,

    wpConfig: null,
    posts: [],
    filteredPosts: [],
    postSearchQuery: '',
    postFilter: 'all',
    setupRequired: false,
    currentPage: 1,
    totalPages: 1,
    isLoadingMore: false,

    isToolGenerationModalOpen: false,
    activePostForModal: null,
    modalStatus: 'idle',
    modalError: null,
    toolIdeas: [],
    contentHealth: null,
    selectedIdea: null,
    generatedQuizHtml: '',
    suggestedContentUpdate: null,
    themeColor: '#3B82F6',
    manualShortcode: null,

    isAnalyticsModalOpen: false,
    activeToolIdForAnalytics: null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

type Action =
    | { type: 'START_LOADING' }
    | { type: 'SET_ERROR'; payload: string }
    | { type: 'CLEAR_ERROR' }
    | { type: 'RESET' }
    | { type: 'SET_THEME'; payload: Theme }
    | { type: 'SET_SETUP_REQUIRED'; payload: boolean }
    | { type: 'CONFIGURE_SUCCESS'; payload: { config: WordPressConfig; posts: WordPressPost[]; totalPages: number } }
    | { type: 'SET_PROVIDER'; payload: AiProvider }
    | { type: 'SET_API_KEY'; payload: { provider: AiProvider; key: string } }
    | { type: 'SET_OPENROUTER_MODEL'; payload: string }
    | { type: 'VALIDATE_API_KEY_START'; payload: AiProvider }
    | { type: 'VALIDATE_API_KEY_RESULT'; payload: { provider: AiProvider; isValid: boolean } }
    | { type: 'SET_POST_SEARCH_QUERY'; payload: string }
    | { type: 'SET_POST_FILTER'; payload: PostFilter }
    | { type: 'LOAD_MORE_START' }
    | { type: 'LOAD_MORE_SUCCESS'; payload: { posts: WordPressPost[]; currentPage: number } }
    | { type: 'START_DELETING_SNIPPET'; payload: number }
    | { type: 'DELETE_SNIPPET_COMPLETE'; payload: { posts: WordPressPost[] } }
    | { type: 'OPEN_TOOL_MODAL'; payload: WordPressPost }
    | { type: 'CLOSE_TOOL_MODAL' }
    | { type: 'SET_MODAL_STATUS'; payload: { status: Status; error?: string } }
    | { type: 'GET_IDEAS_SUCCESS'; payload: { ideas: ToolIdea[]; health: ContentHealth | null } }
    | { type: 'SELECT_IDEA'; payload: ToolIdea }
    | { type: 'GENERATE_ENHANCED_QUIZ_START' }
    | { type: 'GENERATE_ENHANCED_QUIZ_SUCCESS'; payload: { html: string; contentUpdate: string | null } }
    | { type: 'INSERT_SNIPPET_SUCCESS'; payload: { posts: WordPressPost[]; shortcode: string } }
    | { type: 'SET_THEME_COLOR'; payload: string }
    | { type: 'RESTORE_DRAFT'; payload: { ideas: ToolIdea[]; health: ContentHealth | null; selectedIdea: ToolIdea | null; quizHtml: string; contentUpdate: string | null } }
    | { type: 'START_BACKGROUND_ANALYSIS'; payload: number }
    | { type: 'COMPLETE_BACKGROUND_ANALYSIS'; payload: { postId: number; health: ContentHealth } }
    | { type: 'BATCH_UPDATE_POSTS'; payload: Map<number, ContentHealth> }
    | { type: 'OPEN_ANALYTICS_MODAL'; payload: number }
    | { type: 'CLOSE_ANALYTICS_MODAL' }
    | { type: 'STREAM_UPDATE'; payload: { progress: number; stage: string } };

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTORS (Computed outside reducer for performance)
// ═══════════════════════════════════════════════════════════════════════════════

function computeFilteredPosts(
    posts: WordPressPost[],
    searchQuery: string,
    filter: PostFilter
): WordPressPost[] {
    let result = posts;

    // Apply filter
    if (filter === 'with-quiz') {
        result = result.filter(p => p.hasOptimizerSnippet);
    } else if (filter === 'without-quiz') {
        result = result.filter(p => !p.hasOptimizerSnippet);
    }

    // Apply search
    if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        result = result.filter(p =>
            p.title.rendered.toLowerCase().includes(query) ||
            p.content.rendered.toLowerCase().includes(query)
        );
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REDUCER
// ═══════════════════════════════════════════════════════════════════════════════

function appReducer(state: AppState, action: Action): AppState {
    switch (action.type) {
        case 'START_LOADING':
            return { ...state, status: 'loading', error: null };

        case 'SET_ERROR':
            return { ...state, status: 'error', error: action.payload, isLoadingMore: false };

        case 'CLEAR_ERROR':
            return { ...state, error: null };

        case 'RESET': {
            sessionStorage.removeItem(WP_CONFIG_KEY);
            return {
                ...initialState,
                theme: state.theme,
                selectedProvider: state.selectedProvider,
                apiKeys: state.apiKeys,
                apiValidationStatuses: state.apiValidationStatuses,
                openRouterModel: state.openRouterModel,
            };
        }

        case 'SET_THEME':
            return { ...state, theme: action.payload };

        case 'SET_SETUP_REQUIRED':
            return { ...state, setupRequired: action.payload, status: 'idle' };

        case 'CONFIGURE_SUCCESS': {
            const { config, posts, totalPages } = action.payload;
            const filteredPosts = computeFilteredPosts(posts, state.postSearchQuery, state.postFilter);
            return {
                ...state,
                status: 'success',
                wpConfig: config,
                posts,
                filteredPosts,
                totalPages,
                currentPage: 1,
                setupRequired: false,
                error: null,
            };
        }

        case 'SET_PROVIDER':
            return { ...state, selectedProvider: action.payload };

        case 'SET_API_KEY':
            return {
                ...state,
                apiKeys: { ...state.apiKeys, [action.payload.provider]: action.payload.key },
                apiValidationStatuses: { ...state.apiValidationStatuses, [action.payload.provider]: 'idle' },
            };

        case 'SET_OPENROUTER_MODEL':
            return { ...state, openRouterModel: action.payload };

        case 'VALIDATE_API_KEY_START':
            return {
                ...state,
                apiValidationStatuses: { ...state.apiValidationStatuses, [action.payload]: 'validating' },
            };

        case 'VALIDATE_API_KEY_RESULT':
            return {
                ...state,
                apiValidationStatuses: {
                    ...state.apiValidationStatuses,
                    [action.payload.provider]: action.payload.isValid ? 'valid' : 'invalid',
                },
            };

        case 'SET_POST_SEARCH_QUERY': {
            const filteredPosts = computeFilteredPosts(state.posts, action.payload, state.postFilter);
            return { ...state, postSearchQuery: action.payload, filteredPosts };
        }

        case 'SET_POST_FILTER': {
            const filteredPosts = computeFilteredPosts(state.posts, state.postSearchQuery, action.payload);
            return { ...state, postFilter: action.payload, filteredPosts };
        }

        case 'LOAD_MORE_START':
            return { ...state, isLoadingMore: true };

        case 'LOAD_MORE_SUCCESS': {
            const allPosts = [...state.posts, ...action.payload.posts];
            const filteredPosts = computeFilteredPosts(allPosts, state.postSearchQuery, state.postFilter);
            return {
                ...state,
                posts: allPosts,
                filteredPosts,
                currentPage: action.payload.currentPage,
                isLoadingMore: false,
            };
        }

        case 'START_DELETING_SNIPPET':
            return { ...state, deletingPostId: action.payload };

        case 'DELETE_SNIPPET_COMPLETE': {
            const filteredPosts = computeFilteredPosts(action.payload.posts, state.postSearchQuery, state.postFilter);
            return {
                ...state,
                posts: action.payload.posts,
                filteredPosts,
                deletingPostId: null,
                currentPage: 1,
            };
        }

        case 'OPEN_TOOL_MODAL':
            return {
                ...state,
                isToolGenerationModalOpen: true,
                activePostForModal: action.payload,
                modalStatus: 'idle',
                modalError: null,
                toolIdeas: [],
                contentHealth: null,
                selectedIdea: null,
                generatedQuizHtml: '',
                suggestedContentUpdate: null,
                manualShortcode: null,
            };

        case 'CLOSE_TOOL_MODAL':
            return {
                ...state,
                isToolGenerationModalOpen: false,
                activePostForModal: null,
                modalStatus: 'idle',
                modalError: null,
            };

        case 'SET_MODAL_STATUS':
            return {
                ...state,
                modalStatus: action.payload.status,
                modalError: action.payload.error || null,
            };

        case 'GET_IDEAS_SUCCESS':
            return {
                ...state,
                modalStatus: 'success',
                toolIdeas: action.payload.ideas,
                contentHealth: action.payload.health,
            };

        case 'SELECT_IDEA':
            return { ...state, selectedIdea: action.payload };

        case 'GENERATE_ENHANCED_QUIZ_START':
            return { ...state, modalStatus: 'loading', modalError: null };

        case 'GENERATE_ENHANCED_QUIZ_SUCCESS':
            return {
                ...state,
                modalStatus: 'success',
                generatedQuizHtml: action.payload.html,
                suggestedContentUpdate: action.payload.contentUpdate,
            };

        case 'INSERT_SNIPPET_SUCCESS': {
            const filteredPosts = computeFilteredPosts(action.payload.posts, state.postSearchQuery, state.postFilter);
            return {
                ...state,
                modalStatus: 'success',
                posts: action.payload.posts,
                filteredPosts,
                manualShortcode: action.payload.shortcode,
                currentPage: 1,
            };
        }

        case 'SET_THEME_COLOR':
            return { ...state, themeColor: action.payload };

        case 'RESTORE_DRAFT':
            return {
                ...state,
                modalStatus: 'success',
                toolIdeas: action.payload.ideas,
                contentHealth: action.payload.health,
                selectedIdea: action.payload.selectedIdea,
                generatedQuizHtml: action.payload.quizHtml,
                suggestedContentUpdate: action.payload.contentUpdate,
            };

        case 'START_BACKGROUND_ANALYSIS':
            return {
                ...state,
                posts: state.posts.map(p =>
                    p.id === action.payload ? { ...p, isAnalyzing: true } : p
                ),
            };

        case 'COMPLETE_BACKGROUND_ANALYSIS':
            return {
                ...state,
                posts: state.posts.map(p =>
                    p.id === action.payload.postId
                        ? { ...p, isAnalyzing: false, healthAnalysis: action.payload.health }
                        : p
                ),
            };

        case 'BATCH_UPDATE_POSTS': {
            const updates = action.payload;
            const updatedPosts = state.posts.map(p => {
                const health = updates.get(p.id);
                return health ? { ...p, healthAnalysis: health, isAnalyzing: false } : p;
            });
            return { ...state, posts: updatedPosts };
        }

        case 'OPEN_ANALYTICS_MODAL':
            return { ...state, isAnalyticsModalOpen: true, activeToolIdForAnalytics: action.payload };

        case 'CLOSE_ANALYTICS_MODAL':
            return { ...state, isAnalyticsModalOpen: false, activeToolIdForAnalytics: null };

        case 'STREAM_UPDATE':
            // For UI progress indicators during streaming
            return state;

        default:
            return state;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

interface AppContextValue {
    state: AppState;
    connectToWordPress: (config: WordPressConfig) => Promise<void>;
    retryConnection: () => Promise<void>;
    reset: () => void;
    setTheme: (theme: Theme) => void;
    setProvider: (provider: AiProvider) => void;
    setApiKey: (provider: AiProvider, key: string) => void;
    setOpenRouterModel: (model: string) => void;
    validateAndSaveApiKey: (provider: AiProvider) => Promise<void>;
    setPostSearchQuery: (query: string) => void;
    setPostFilter: (filter: PostFilter) => void;
    deleteSnippet: (postId: number, toolId?: number) => Promise<void>;
    loadMorePosts: () => Promise<void>;
    openAnalyticsModal: (toolId: number) => void;
    closeAnalyticsModal: () => void;
    beginToolCreation: (post: WordPressPost) => void;
    closeToolGenerationModal: () => void;
    generateIdeasForModal: (onStream?: StreamCallback) => Promise<void>;
    selectIdea: (idea: ToolIdea) => void;
    generateEnhancedQuizForModal: (strategy: OptimizationStrategy, onStream?: StreamCallback) => Promise<void>;
    insertSnippet: (placement: Placement) => Promise<void>;
    setThemeColor: (color: string) => void;
    runBackgroundAnalysis: (posts: WordPressPost[]) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER
// ═══════════════════════════════════════════════════════════════════════════════

export const AppContextProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [state, dispatch] = useReducer(appReducer, initialState, (init) => {
        try {
            const cachedWpConfig = sessionStorage.getItem(WP_CONFIG_KEY);
            const cachedAiConfig = localStorage.getItem(AI_CONFIG_KEY);

            let wpState = {};
            let aiState = {};

            if (cachedWpConfig) {
                wpState = { wpConfig: JSON.parse(cachedWpConfig) };
            }

            if (cachedAiConfig) {
                const parsed = JSON.parse(cachedAiConfig);
                aiState = {
                    selectedProvider: parsed.selectedProvider || AiProvider.Gemini,
                    apiKeys: { ...initialApiKeys, ...(parsed.apiKeys || {}) },
                    openRouterModel: parsed.openRouterModel || init.openRouterModel,
                };
            }

            return {
                ...init,
                ...wpState,
                ...aiState,
                theme: getInitialTheme(),
            };
        } catch (e) {
            console.error('Failed to load state from storage', e);
            return { ...init, theme: getInitialTheme() };
        }
    });

    // Refs for avoiding stale closures
    const stateRef = useRef(state);
    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    // Theme persistence
    useEffect(() => {
        const root = window.document.documentElement;
        root.classList.remove('light', 'dark');
        root.classList.add(state.theme);
        localStorage.setItem(THEME_KEY, state.theme);
    }, [state.theme]);

    // Initial posts fetch
    useEffect(() => {
        const fetchInitialPosts = async () => {
            if (state.wpConfig && state.posts.length === 0) {
                dispatch({ type: 'START_LOADING' });
                try {
                    const { posts, totalPages } = await fetchPosts(state.wpConfig, 1);
                    dispatch({ type: 'CONFIGURE_SUCCESS', payload: { config: state.wpConfig, posts, totalPages } });
                } catch (err) {
                    dispatch({ type: 'SET_ERROR', payload: err instanceof Error ? err.message : 'Failed to fetch posts' });
                }
            }
        };
        fetchInitialPosts();
    }, [state.wpConfig]);

    // AI config persistence
    useEffect(() => {
        const aiConfig = {
            selectedProvider: state.selectedProvider,
            apiKeys: state.apiKeys,
            openRouterModel: state.openRouterModel,
        };
        localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(aiConfig));
    }, [state.selectedProvider, state.apiKeys, state.openRouterModel]);

    // Periodic maintenance
    useEffect(() => {
        runMaintenance().catch(console.error);
    }, []);

    // ═══════════════════════════════════════════════════════════════════════════
    // ACTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    const reset = useCallback(() => dispatch({ type: 'RESET' }), []);

    const setTheme = useCallback((theme: Theme) => {
        dispatch({ type: 'SET_THEME', payload: theme });
    }, []);

    const connectToWordPress = useCallback(async (config: WordPressConfig) => {
        dispatch({ type: 'START_LOADING' });
        try {
            const isSetup = await checkSetup(config);
            if (!isSetup) {
                dispatch({ type: 'SET_SETUP_REQUIRED', payload: true });
                dispatch({ type: 'SET_ERROR', payload: 'A one-time setup is required.' });
                sessionStorage.setItem(WP_CONFIG_KEY, JSON.stringify(config));
                return;
            }

            const { posts, totalPages } = await fetchPosts(config, 1);
            sessionStorage.setItem(WP_CONFIG_KEY, JSON.stringify(config));
            dispatch({ type: 'CONFIGURE_SUCCESS', payload: { config, posts, totalPages } });
        } catch (err) {
            dispatch({ type: 'SET_ERROR', payload: err instanceof Error ? err.message : 'An unknown error occurred' });
        }
    }, []);

    const retryConnection = useCallback(async () => {
        const cachedConfig = sessionStorage.getItem(WP_CONFIG_KEY);
        if (cachedConfig) {
            const config = JSON.parse(cachedConfig);
            if (config.url && config.username && config.appPassword) {
                await connectToWordPress(config);
            } else {
                dispatch({ type: 'SET_ERROR', payload: 'Cached credentials incomplete. Please re-enter.' });
                dispatch({ type: 'SET_SETUP_REQUIRED', payload: false });
            }
        } else {
            dispatch({ type: 'SET_ERROR', payload: 'No connection details to retry. Please start over.' });
            dispatch({ type: 'RESET' });
        }
    }, [connectToWordPress]);

    const loadMorePosts = useCallback(async () => {
        const { wpConfig, isLoadingMore, currentPage, totalPages } = stateRef.current;
        if (!wpConfig || isLoadingMore || currentPage >= totalPages) return;

        dispatch({ type: 'LOAD_MORE_START' });
        try {
            const nextPage = currentPage + 1;
            const { posts } = await fetchPosts(wpConfig, nextPage);
            dispatch({ type: 'LOAD_MORE_SUCCESS', payload: { posts, currentPage: nextPage } });
        } catch (err) {
            dispatch({ type: 'SET_ERROR', payload: err instanceof Error ? err.message : 'Failed to load more posts' });
        }
    }, []);

    const deleteSnippet = useCallback(async (postId: number, toolId?: number) => {
        const { wpConfig, posts } = stateRef.current;
        if (!wpConfig) return;

        const postToDeleteFrom = posts.find(p => p.id === postId);
        if (!postToDeleteFrom || typeof postToDeleteFrom.content.raw !== 'string') {
            dispatch({ type: 'SET_ERROR', payload: 'Could not delete quiz: Raw post content is not available.' });
            return;
        }

        dispatch({ type: 'START_DELETING_SNIPPET', payload: postId });
        try {
            let newContent = postToDeleteFrom.content.raw;
            newContent = newContent.replace(SHORTCODE_REMOVAL_REGEX, '');
            newContent = newContent.replace(/(\r\n|\n|\r){2,}/g, '\n').trim();

            await updatePost(wpConfig, postId, newContent);
            if (toolId) {
                await deleteCfTool(wpConfig, toolId);
            }

            const { posts: refreshedPosts } = await fetchPosts(wpConfig, 1);
            dispatch({ type: 'DELETE_SNIPPET_COMPLETE', payload: { posts: refreshedPosts } });
        } catch (err) {
            dispatch({ type: 'SET_ERROR', payload: err instanceof Error ? err.message : 'Failed to delete snippet' });
        }
    }, []);

    // AI Provider Actions
    const setProvider = useCallback((provider: AiProvider) => {
        dispatch({ type: 'SET_PROVIDER', payload: provider });
    }, []);

    const setApiKey = useCallback((provider: AiProvider, key: string) => {
        dispatch({ type: 'SET_API_KEY', payload: { provider, key } });
    }, []);

    const setOpenRouterModel = useCallback((model: string) => {
        dispatch({ type: 'SET_OPENROUTER_MODEL', payload: model });
    }, []);

    const validateAndSaveApiKey = useCallback(async (provider: AiProvider) => {
        dispatch({ type: 'VALIDATE_API_KEY_START', payload: provider });
        const { apiKeys, openRouterModel } = stateRef.current;
        const key = apiKeys[provider];
        const isValid = await validateApiKey(provider, key, openRouterModel);
        dispatch({ type: 'VALIDATE_API_KEY_RESULT', payload: { provider, isValid } });
    }, []);

    // Post Dashboard Actions
    const setPostSearchQuery = useCallback((query: string) => {
        dispatch({ type: 'SET_POST_SEARCH_QUERY', payload: query });
    }, []);

    const setPostFilter = useCallback((filter: PostFilter) => {
        dispatch({ type: 'SET_POST_FILTER', payload: filter });
    }, []);

    // Analytics Modal Actions
    const openAnalyticsModal = useCallback((toolId: number) => {
        dispatch({ type: 'OPEN_ANALYTICS_MODAL', payload: toolId });
    }, []);

    const closeAnalyticsModal = useCallback(() => {
        dispatch({ type: 'CLOSE_ANALYTICS_MODAL' });
    }, []);

    // Tool Generation Modal Actions
    const beginToolCreation = useCallback(async (post: WordPressPost) => {
        dispatch({ type: 'OPEN_TOOL_MODAL', payload: post });

        const draft = await getDraft(post.id);
        const health = draft?.health || post.healthAnalysis || null;
        const ideas = draft?.ideas || [];

        if (draft && ideas.length > 0) {
            dispatch({
                type: 'RESTORE_DRAFT',
                payload: {
                    ideas,
                    health,
                    selectedIdea: draft.selectedIdea || null,
                    quizHtml: draft.generatedQuizHtml || '',
                    contentUpdate: draft.suggestedContentUpdate || null,
                },
            });
        } else if (health) {
            dispatch({ type: 'GET_IDEAS_SUCCESS', payload: { ideas: [], health } });
        }
    }, []);

    const closeToolGenerationModal = useCallback(() => {
        dispatch({ type: 'CLOSE_TOOL_MODAL' });
    }, []);

    const generateIdeasForModal = useCallback(async (onStream?: StreamCallback) => {
        const { activePostForModal } = stateRef.current;
        if (!activePostForModal) return;

        dispatch({ type: 'SET_MODAL_STATUS', payload: { status: 'loading' } });
        try {
            const { title, content, id } = activePostForModal;
            const contentForAnalysis = content.raw || content.rendered;
            const analysis = await analyzeContentHealth(stateRef.current, title.rendered, contentForAnalysis, onStream);

            await saveDraft(id, { ideas: analysis.ideas, health: analysis.health });
            dispatch({ type: 'GET_IDEAS_SUCCESS', payload: { ideas: analysis.ideas, health: analysis.health } });
        } catch (err) {
            dispatch({
                type: 'SET_MODAL_STATUS',
                payload: { status: 'error', error: err instanceof Error ? err.message : 'Failed to generate ideas' },
            });
        }
    }, []);

    const selectIdea = useCallback((idea: ToolIdea) => {
        const { activePostForModal, toolIdeas, contentHealth } = stateRef.current;
        if (activePostForModal) {
            saveDraft(activePostForModal.id, { ideas: toolIdeas, health: contentHealth, selectedIdea: idea });
        }
        dispatch({ type: 'SELECT_IDEA', payload: idea });
    }, []);

    const generateEnhancedQuizForModal = useCallback(async (strategy: OptimizationStrategy, onStream?: StreamCallback) => {
        const { activePostForModal, selectedIdea, posts, themeColor, theme, toolIdeas, contentHealth } = stateRef.current;
        if (!activePostForModal || !selectedIdea) return;

        dispatch({ type: 'GENERATE_ENHANCED_QUIZ_START' });
        try {
            const { title, content, id } = activePostForModal;
            const contentForAnalysis = content.raw || content.rendered;

            const [quizResult, contentUpdate] = await Promise.all([
                generateQuizAndMetadata(stateRef.current, title.rendered, contentForAnalysis, selectedIdea, strategy, posts, onStream),
                generateContentUpdate(stateRef.current, title.rendered, selectedIdea.title),
            ]);

            const finalHtml = createQuizSnippet(quizResult, themeColor, theme);

            await saveDraftImmediate(id, {
                ideas: toolIdeas,
                health: contentHealth,
                selectedIdea,
                generatedQuizHtml: finalHtml,
                suggestedContentUpdate: contentUpdate,
            });

            dispatch({ type: 'GENERATE_ENHANCED_QUIZ_SUCCESS', payload: { html: finalHtml, contentUpdate } });
        } catch (err) {
            dispatch({
                type: 'SET_MODAL_STATUS',
                payload: { status: 'error', error: err instanceof Error ? err.message : 'Failed to generate quiz' },
            });
        }
    }, []);

    const insertSnippet = useCallback(async (placement: Placement) => {
        const { activePostForModal, generatedQuizHtml, wpConfig } = stateRef.current;
        if (!activePostForModal || !generatedQuizHtml || !wpConfig) return;

        dispatch({ type: 'SET_MODAL_STATUS', payload: { status: 'loading' } });
        try {
            const toolId = await createCfTool(wpConfig, `Quiz: ${activePostForModal.title.rendered}`, generatedQuizHtml);
            const shortcode = `[contentforge_tool id="${toolId}"]`;

            if (placement !== 'manual') {
                let newContent = activePostForModal.content.raw || activePostForModal.content.rendered;
                if (placement === 'end') {
                    newContent = `${newContent}\n\n${shortcode}`;
                } else {
                    // AI placement - find optimal position
                    const paragraphs = newContent.split(/(<\/p>)/i);
                    const insertIndex = Math.min(Math.floor(paragraphs.length * 0.4), paragraphs.length - 2);
                    paragraphs.splice(insertIndex + 1, 0, `\n\n${shortcode}\n\n`);
                    newContent = paragraphs.join('');
                }
                await updatePost(wpConfig, activePostForModal.id, newContent);
            }

            const { posts } = await fetchPosts(wpConfig, 1);
            dispatch({ type: 'INSERT_SNIPPET_SUCCESS', payload: { posts, shortcode } });
        } catch (err) {
            dispatch({
                type: 'SET_MODAL_STATUS',
                payload: { status: 'error', error: err instanceof Error ? err.message : 'Failed to insert snippet' },
            });
        }
    }, []);

    const setThemeColor = useCallback((color: string) => {
        dispatch({ type: 'SET_THEME_COLOR', payload: color });
    }, []);

    const runBackgroundAnalysis = useCallback((posts: WordPressPost[]) => {
        const candidates = posts
            .filter(p => !p.hasOptimizerSnippet && !p.healthAnalysis && !p.isAnalyzing)
            .slice(0, 5);

        if (candidates.length === 0) return;

        // Process in background
        candidates.forEach(async (post) => {
            const currentState = stateRef.current;
            if (currentState.posts.find(p => p.id === post.id)?.isAnalyzing) return;

            dispatch({ type: 'START_BACKGROUND_ANALYSIS', payload: post.id });

            const draft = await getDraft(post.id);
            if (draft && draft.health) {
                dispatch({ type: 'COMPLETE_BACKGROUND_ANALYSIS', payload: { postId: post.id, health: draft.health } });
                return;
            }

            try {
                const content = post.content.raw || post.content.rendered;
                const analysis = await analyzeContentHealth(stateRef.current, post.title.rendered, content);
                dispatch({ type: 'COMPLETE_BACKGROUND_ANALYSIS', payload: { postId: post.id, health: analysis.health } });
                saveDraft(post.id, { health: analysis.health, ideas: analysis.ideas });
            } catch (e) {
                console.warn('Background analysis failed silently', e);
            }
        });
    }, []);

    // ═══════════════════════════════════════════════════════════════════════════
    // MEMOIZED VALUE
    // ═══════════════════════════════════════════════════════════════════════════

    const value = useMemo<AppContextValue>(() => ({
        state,
        connectToWordPress,
        retryConnection,
        reset,
        setTheme,
        setProvider,
        setApiKey,
        setOpenRouterModel,
        validateAndSaveApiKey,
        setPostSearchQuery,
        setPostFilter,
        deleteSnippet,
        loadMorePosts,
        openAnalyticsModal,
        closeAnalyticsModal,
        beginToolCreation,
        closeToolGenerationModal,
        generateIdeasForModal,
        selectIdea,
        generateEnhancedQuizForModal,
        insertSnippet,
        setThemeColor,
        runBackgroundAnalysis,
    }), [
        state,
        connectToWordPress,
        retryConnection,
        reset,
        setTheme,
        setProvider,
        setApiKey,
        setOpenRouterModel,
        validateAndSaveApiKey,
        setPostSearchQuery,
        setPostFilter,
        deleteSnippet,
        loadMorePosts,
        openAnalyticsModal,
        closeAnalyticsModal,
        beginToolCreation,
        closeToolGenerationModal,
        generateIdeasForModal,
        selectIdea,
        generateEnhancedQuizForModal,
        insertSnippet,
        setThemeColor,
        runBackgroundAnalysis,
    ]);

    return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useAppContext = () => {
    const context = useContext(AppContext);
    if (!context) {
        throw new Error('useAppContext must be used within an AppContextProvider');
    }
    return context;
};

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTOR HOOKS (For performance-critical components)
// ═══════════════════════════════════════════════════════════════════════════════

export const useFilteredPosts = () => {
    const { state } = useAppContext();
    return state.filteredPosts;
};

export const useModalState = () => {
    const { state } = useAppContext();
    return useMemo(() => ({
        isOpen: state.isToolGenerationModalOpen,
        status: state.modalStatus,
        error: state.modalError,
        ideas: state.toolIdeas,
        health: state.contentHealth,
        selectedIdea: state.selectedIdea,
        html: state.generatedQuizHtml,
        shortcode: state.manualShortcode,
    }), [
        state.isToolGenerationModalOpen,
        state.modalStatus,
        state.modalError,
        state.toolIdeas,
        state.contentHealth,
        state.selectedIdea,
        state.generatedQuizHtml,
        state.manualShortcode,
    ]);
};
