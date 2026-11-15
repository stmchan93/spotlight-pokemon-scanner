import { supabase } from '@/lib/supabase';

/** The reactions on one article; absent until someone first reacts to it. */
export type NewsThread = {
  postId: string;
  likeCount: number;
  commentCount: number;
  repostCount: number;
};

type NewsThreadRow = {
  news_item_id: string;
  post_id: string;
  posts: { like_count: number | null; comment_count: number | null; repost_count: number | null } | null;
};

/** Reaction counts for a page of articles. An unreachable read yields no threads. */
export async function fetchNewsThreads(newsIds: string[]): Promise<Map<string, NewsThread>> {
  const threads = new Map<string, NewsThread>();
  if (!supabase || newsIds.length === 0) {
    return threads;
  }
  try {
    const { data, error } = await supabase
      .from('news_threads')
      .select('news_item_id, post_id, posts(like_count, comment_count, repost_count)')
      .in('news_item_id', newsIds);
    if (!error && data) {
      for (const row of data as unknown as NewsThreadRow[]) {
        threads.set(row.news_item_id, {
          postId: row.post_id,
          likeCount: row.posts?.like_count ?? 0,
          commentCount: row.posts?.comment_count ?? 0,
          repostCount: row.posts?.repost_count ?? 0,
        });
      }
    }
  } catch {
    // Rows render with zero counts rather than failing the page.
  }
  return threads;
}
