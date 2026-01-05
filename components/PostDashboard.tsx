
import React, { useState, useEffect, memo, useCallback } from 'react';
import { WordPressPost, PostFilter, ContentHealth } from '../types';
import { Card } from './common/Card';
import { Button } from './common/Button';
import { useAppContext } from '../context/AppContext';
import { Input } from './common/Input';
import { SearchIcon } from './icons/SearchIcon';
import { CheckIcon } from './icons/CheckIcon';
import { WorldIcon } from './icons/FormIcons';
import { Spinner } from './common/Spinner';
import { ConfirmationModal } from './common/ConfirmationModal';
import { SparklesIcon } from './icons/SparklesIcon';
import { Skeleton } from './common/Skeleton';
import { ChartIcon } from './icons/ToolIcons';

const HealthBadge: React.FC<{ health?: ContentHealth | null, isAnalyzing?: boolean }> = ({ health, isAnalyzing }) => {
    if (isAnalyzing) {
        return (
            <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-blue-100/90 dark:bg-blue-900/90 backdrop-blur-sm text-blue-700 dark:text-blue-300 text-[10px] font-bold px-2 py-1 rounded-full animate-pulse shadow-sm z-10">
                <Spinner /> Analyzing...
            </div>
        );
    }
    if (!health) return null;

    let colorClass = 'bg-slate-100 text-slate-700';
    if (health.score >= 80) colorClass = 'bg-green-100 text-green-800 dark:bg-green-900/80 dark:text-green-100 border border-green-200 dark:border-green-700';
    else if (health.score >= 50) colorClass = 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/80 dark:text-yellow-100 border border-yellow-200 dark:border-yellow-700';
    else colorClass = 'bg-red-100 text-red-800 dark:bg-red-900/80 dark:text-red-100 border border-red-200 dark:border-red-700';

    return (
        <div className={`absolute top-3 right-3 flex items-center gap-1.5 ${colorClass} backdrop-blur-sm text-[10px] font-bold px-2 py-1 rounded-full shadow-sm z-10 transition-all duration-500 animate-fade-in`}>
            <ChartIcon className="w-3 h-3" />
            Health: {health.score}/100
        </div>
    );
};

// SOTA: Memoized Card to prevent grid re-renders on individual updates
const PostCard = memo(({ 
  post, 
  onDeleteRequest,
  onCreateRequest,
  onAnalyticsRequest,
  isDeleting
}: { 
  post: WordPressPost, 
  onDeleteRequest: (post: WordPressPost) => void,
  onCreateRequest: (post: WordPressPost) => void,
  onAnalyticsRequest: (post: WordPressPost) => void,
  isDeleting: boolean
}) => {

  return (
    <Card className={`flex flex-col relative overflow-hidden transition-all duration-300 group ${isDeleting ? 'opacity-60' : 'hover:!border-blue-500'}`}>
      {/* SOTA: Autonomous Health Badge */}
      {!post.hasOptimizerSnippet && <HealthBadge health={post.healthAnalysis} isAnalyzing={post.isAnalyzing} />}

      {isDeleting && (
        <div className="absolute inset-0 bg-white/50 dark:bg-slate-900/50 flex items-center justify-center z-10 rounded-xl">
          <Spinner/>
          <span className="ml-2">Deleting...</span>
        </div>
      )}
      <div className="aspect-video bg-slate-100 dark:bg-slate-700 rounded-md mb-4 overflow-hidden relative">
        {post.featuredImageUrl ? (
          <img src={post.featuredImageUrl} alt="" className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-400 dark:text-slate-500">
            <SparklesIcon className="w-12 h-12" />
          </div>
        )}
      </div>
      <div className="flex-grow">
        <h3 className="font-bold text-slate-800 dark:text-slate-100 line-clamp-2" dangerouslySetInnerHTML={{ __html: post.title.rendered }} />
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <a href={post.link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors truncate">
          <WorldIcon className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">{post.link.replace(/^https?:\/\//, '')}</span>
        </a>
      </div>
      <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
        {post.hasOptimizerSnippet ? (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-green-100 dark:bg-green-900/70 text-green-700 dark:text-green-300 text-xs font-semibold px-2 py-1 rounded-full">
                  <CheckIcon className="w-4 h-4" />
                  <span>Quiz Active</span>
              </div>
              <Button
                onClick={(e) => { e.stopPropagation(); onAnalyticsRequest(post); }}
                variant="secondary"
                size="normal"
                className="!text-sm !py-1.5 !px-3"
                disabled={isDeleting}
              >
                <ChartIcon className="w-4 h-4 mr-1.5"/>
                Analytics
              </Button>
            </div>
            <Button
              onClick={(e) => { e.stopPropagation(); onDeleteRequest(post); }}
              variant="secondary"
              size="normal"
              className="!text-sm !py-1.5 !px-3 bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60 focus:ring-red-500"
              disabled={isDeleting}
            >
              Delete
            </Button>
          </div>
        ) : (
          <Button onClick={(e) => { e.stopPropagation(); onCreateRequest(post); }} className="w-full" disabled={isDeleting}>
              <SparklesIcon className="w-5 h-5 mr-2"/>
              Create Quiz
          </Button>
        )}
      </div>
    </Card>
  );
});

const PostGridSkeleton: React.FC = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
        {Array.from({ length: 12 }).map((_, i) => (
             <Card key={i} className="flex flex-col">
                <Skeleton className="aspect-video w-full mb-4"/>
                <Skeleton className="h-5 w-3/4 mb-2"/>
                <Skeleton className="h-5 w-1/2 mb-4"/>
                <div className="mt-auto pt-4 border-t border-slate-200 dark:border-slate-700">
                    <Skeleton className="h-10 w-full"/>
                </div>
             </Card>
        ))}
    </div>
);

const FilterButton: React.FC<{
    label: string;
    value: PostFilter;
    currentFilter: PostFilter;
    onClick: (filter: PostFilter) => void;
    disabled: boolean;
}> = ({ label, value, currentFilter, onClick, disabled }) => (
    <button
        onClick={() => onClick(value)}
        disabled={disabled}
        className={`px-3 py-1.5 text-sm font-semibold rounded-full transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${
            currentFilter === value
                ? 'bg-blue-600 text-white shadow'
                : 'bg-white/60 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
        }`}
    >
        {label}
    </button>
);


export default function PostDashboard(): React.ReactNode {
  const { state, setPostSearchQuery, deleteSnippet, beginToolCreation, setPostFilter, openAnalyticsModal, loadMorePosts, runBackgroundAnalysis } = useAppContext();
  const { status, filteredPosts, postSearchQuery, postFilter, deletingPostId, error, currentPage, totalPages, isLoadingMore } = state;
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [postToDelete, setPostToDelete] = useState<WordPressPost | null>(null);
  
  const isLoading = status === 'loading';

  // SOTA: Trigger Autonomous Analysis when posts change
  useEffect(() => {
    if (!isLoading && filteredPosts.length > 0) {
        // Simple debounce to avoid spamming while typing search query
        const timer = setTimeout(() => {
            runBackgroundAnalysis(filteredPosts);
        }, 1000);
        return () => clearTimeout(timer);
    }
  }, [filteredPosts, isLoading, runBackgroundAnalysis]);

  // Stable callbacks for Memoized PostCard
  const handleDeleteRequest = useCallback((post: WordPressPost) => {
    setPostToDelete(post);
    setIsModalOpen(true);
  }, []);
  
  const handleCreateRequest = useCallback((post: WordPressPost) => {
    beginToolCreation(post);
  }, [beginToolCreation]);

  const handleAnalyticsRequest = useCallback((post: WordPressPost) => {
    if (post.toolId) {
      openAnalyticsModal(post.toolId);
    }
  }, [openAnalyticsModal]);

  const handleConfirmDelete = () => {
    if (postToDelete) {
      deleteSnippet(postToDelete.id, postToDelete.toolId).finally(() => {
        setIsModalOpen(false);
        setPostToDelete(null);
      });
    }
  };

  const renderContent = () => {
    if (isLoading && filteredPosts.length === 0) {
        return <PostGridSkeleton />;
    }
    if (error && !isLoadingMore) {
        return (
            <div className="bg-red-100 dark:bg-red-900/50 border border-red-400 dark:border-red-600 text-red-700 dark:text-red-300 px-4 py-3 rounded-md max-w-3xl mx-auto" role="alert">
              <strong className="font-bold">Error: </strong>
              <span>{error}</span>
            </div>
        );
    }
     if (filteredPosts.length === 0 && (postSearchQuery || postFilter !== 'all')) {
        return (
            <div className="text-center py-16 text-slate-500 dark:text-slate-400">
                <p className="font-semibold">No posts match your criteria.</p>
                <p>Try adjusting your search or filter.</p>
            </div>
        );
    }
    if (filteredPosts.length === 0) {
        return (
            <div className="text-center py-16 text-slate-500 dark:text-slate-400">
                <p className="font-semibold text-lg">No posts found</p>
                <p>It looks like there are no published posts on your WordPress site.</p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
            {filteredPosts.map((post) => (
                <PostCard 
                    key={post.id} 
                    post={post}
                    onCreateRequest={handleCreateRequest}
                    onDeleteRequest={handleDeleteRequest}
                    onAnalyticsRequest={handleAnalyticsRequest}
                    isDeleting={deletingPostId === post.id}
                />
            ))}
        </div>
    );
  }

  return (
    <>
      <div className="animate-fade-in space-y-8">
        <section className="bg-white/60 dark:bg-slate-900/60 rounded-2xl p-4 sm:p-6 border border-white/20 dark:border-slate-700/80 backdrop-blur-2xl">
            <div className="flex flex-col sm:flex-row gap-4 justify-between sm:items-center mb-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                        Post Dashboard
                        {/* Status Indicator for SOTA background work */}
                        {filteredPosts.some(p => p.isAnalyzing) && (
                            <span className="text-xs font-normal text-slate-500 dark:text-slate-400 animate-pulse flex items-center gap-1">
                                <span className="w-2 h-2 bg-blue-500 rounded-full inline-block"></span>
                                AI Agent Active
                            </span>
                        )}
                    </h1>
                    <p className="text-slate-600 dark:text-slate-400">Select a post to create a new quiz, or manage existing ones.</p>
                </div>
                <div className="w-full sm:w-auto sm:max-w-xs">
                    <Input 
                        type="search"
                        icon={<SearchIcon className="w-5 h-5" />}
                        placeholder="Search posts..."
                        value={postSearchQuery}
                        onChange={(e) => setPostSearchQuery(e.target.value)}
                        disabled={isLoading}
                    />
                </div>
            </div>
            <div className="flex items-center gap-2 mb-6 border-t border-slate-200 dark:border-slate-700 pt-4">
                <span className="text-sm font-semibold text-slate-600 dark:text-slate-400 flex-shrink-0">Filter by:</span>
                <div className="flex items-center gap-2 flex-wrap">
                    <FilterButton label="All Posts" value="all" currentFilter={postFilter} onClick={setPostFilter} disabled={isLoading} />
                    <FilterButton label="With Quiz" value="with-quiz" currentFilter={postFilter} onClick={setPostFilter} disabled={isLoading} />
                    <FilterButton label="Without Quiz" value="without-quiz" currentFilter={postFilter} onClick={setPostFilter} disabled={isLoading} />
                </div>
            </div>
            {renderContent()}

            {currentPage < totalPages && (
                <div className="mt-8 text-center">
                    <Button
                        onClick={loadMorePosts}
                        disabled={isLoadingMore}
                        variant="secondary"
                        size="large"
                    >
                        {isLoadingMore ? <><Spinner/>Loading...</> : 'Load More Posts'}
                    </Button>
                </div>
            )}
        </section>
      </div>

      <ConfirmationModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConfirm={handleConfirmDelete}
        title="Confirm Quiz Deletion"
        confirmText="Delete Quiz"
        isConfirming={deletingPostId !== null}
      >
        <p>
          Are you sure you want to permanently delete the quiz from the post:
          <strong className="block mt-2" dangerouslySetInnerHTML={{ __html: postToDelete?.title.rendered || '' }} />
        </p>
        <p className="mt-2 text-sm text-slate-500">
          This will remove the shortcode from the post and delete the quiz's data from WordPress. This action cannot be undone.
        </p>
    </ConfirmationModal>
  </>
  );
}
