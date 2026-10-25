import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, cx } from "./ui";

interface FeedPost {
  id: string;
  authorId: string;
  authorName: string;
  mediaUrl: string;
  caption: string | null;
  createdAt: string;
  expiresAt: string;
}

function formatTimeRemaining(expiresAt: string): string {
  const now = Date.now();
  const exp = new Date(expiresAt).getTime();
  const diff = exp - now;

  if (diff <= 0) return "Expired";

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) return `${days} day${days === 1 ? "" : "s"}`;
  if (hours > 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return "< 1 hour";
}

function isExpiringSoon(expiresAt: string): boolean {
  const now = Date.now();
  const exp = new Date(expiresAt).getTime();
  const diff = exp - now;
  return diff < 1000 * 60 * 60 * 24; // Less than 1 day
}

async function downloadMedia(url: string, filename: string): Promise<void> {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
  } catch (err) {
    console.error("Download failed:", err);
  }
}

export function FeedSection() {
  const { account } = useAuth();
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadFeed();
  }, []);

  async function loadFeed() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getFeed();
      setPosts(data.posts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load feed");
    } finally {
      setLoading(false);
    }
  }

  if (!account) return null;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-ink-500 dark:text-night-text">Loading feed...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
        <Button onClick={loadFeed}>Retry</Button>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <div className="text-lg font-semibold text-ink-900 dark:text-night-text">No feed posts yet</div>
        <div className="text-sm text-ink-500 dark:text-night-text">
          Posts from your contacts will appear here. They auto-delete after 7 days.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-ink-200/70 px-6 py-4 dark:border-night-border">
        <h2 className="text-lg font-semibold text-ink-900 dark:text-night-text">Feed</h2>
        <p className="text-sm text-ink-500 dark:text-night-text">Posts from your contacts</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 p-4">
          {posts.map((post) => {
            const expiringSoon = isExpiringSoon(post.expiresAt);
            const timeRemaining = formatTimeRemaining(post.expiresAt);

            return (
              <div
                key={post.id}
                className={cx(
                  "overflow-hidden rounded-lg border bg-white shadow-sm dark:bg-night-surface",
                  expiringSoon
                    ? "border-orange-300 dark:border-orange-700"
                    : "border-ink-200/70 dark:border-night-border",
                )}
              >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3 dark:border-night-border">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-sm font-semibold text-white">
                      {post.authorName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="font-medium text-ink-900 dark:text-night-text">{post.authorName}</div>
                      <div className="text-xs text-ink-500 dark:text-night-text">
                        {new Date(post.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>

                  {/* Timer badge */}
                  <div
                    className={cx(
                      "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
                      expiringSoon
                        ? "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300"
                        : "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
                    )}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span>{timeRemaining}</span>
                  </div>
                </div>

                {/* Media */}
                <div className="relative bg-ink-50 dark:bg-night-bg">
                  <img
                    src={post.mediaUrl}
                    alt={post.caption || "Feed post"}
                    className="h-auto w-full object-cover"
                    style={{ maxHeight: "500px" }}
                  />
                </div>

                {/* Caption */}
                {post.caption && (
                  <div className="border-t border-ink-100 px-4 py-3 dark:border-night-border">
                    <p className="text-sm text-ink-900 dark:text-night-text">{post.caption}</p>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center justify-between border-t border-ink-100 px-4 py-3 dark:border-night-border">
                  <div className="text-xs text-ink-500 dark:text-night-text">
                    Expires in {timeRemaining.toLowerCase()}
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const ext = post.mediaUrl.split(".").pop()?.split("?")[0] || "jpg";
                      downloadMedia(post.mediaUrl, `feed-${post.id}.${ext}`);
                    }}
                  >
                    <svg className="mr-1.5 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                      />
                    </svg>
                    Save to Device
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}