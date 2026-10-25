import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Image, Linking, Pressable, Text, View } from "react-native";
import { api, resolveMediaUrl } from "../api";
import { Button, CardBox, Heading, Muted, Screen, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

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

export function FeedScreen() {
  const palette = usePalette();
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

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

  async function handleDownload(post: FeedPost) {
    setDownloading(post.id);
    try {
      const mediaUrl = resolveMediaUrl(post.mediaUrl);
      if (!mediaUrl) throw new Error("Invalid media URL");

      // Open the media URL in the device browser/app for saving
      const supported = await Linking.canOpenURL(mediaUrl);
      if (!supported) {
        Alert.alert("Cannot open media", "Unable to open the media URL.");
        return;
      }
      await Linking.openURL(mediaUrl);
    } catch (err) {
      Alert.alert("Download failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDownloading(null);
    }
  }

  if (loading) {
    return (
      <Screen palette={palette}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color={colors.iris600} />
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen palette={palette}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.lg }}>
          <Muted palette={palette}>{error}</Muted>
          <View style={{ height: spacing.md }} />
          <Button label="Retry" onPress={loadFeed} />
        </View>
      </Screen>
    );
  }

  if (posts.length === 0) {
    return (
      <Screen palette={palette}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.lg }}>
          <Heading palette={palette}>No feed posts yet</Heading>
          <View style={{ height: spacing.sm }} />
          <View style={{ alignItems: "center" }}>
            <Muted palette={palette}>
              Posts from your contacts will appear here. They auto-delete after 7 days.
            </Muted>
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen palette={palette}>
      <FlatList
        data={posts}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: spacing.md }}
        renderItem={({ item: post }) => {
          const expiringSoon = isExpiringSoon(post.expiresAt);
          const timeRemaining = formatTimeRemaining(post.expiresAt);
          const isDownloading = downloading === post.id;

          return (
            <View style={{ marginBottom: spacing.md }}>
              <CardBox palette={palette}>
                {/* Header */}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: spacing.sm,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        backgroundColor: colors.iris600,
                        justifyContent: "center",
                        alignItems: "center",
                      }}
                    >
                      <Text style={{ color: colors.white, fontWeight: "700", fontSize: 16 }}>
                        {post.authorName.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View>
                      <Text style={{ fontWeight: "600", fontSize: 15, color: palette.text }}>
                        {post.authorName}
                      </Text>
                      <Text style={{ fontSize: 12, color: palette.textMuted }}>
                        {new Date(post.createdAt).toLocaleDateString()}
                      </Text>
                    </View>
                  </View>

                  {/* Timer badge */}
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                      backgroundColor: expiringSoon ? colors.ink100 : colors.iris100,
                      paddingHorizontal: spacing.sm,
                      paddingVertical: 4,
                      borderRadius: radius.pill,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "600", color: expiringSoon ? colors.ink700 : colors.iris700 }}>
                      {timeRemaining}
                    </Text>
                  </View>
                </View>

                {/* Media */}
                <Image
                  source={{ uri: resolveMediaUrl(post.mediaUrl) ?? undefined }}
                  style={{
                    width: "100%",
                    aspectRatio: 1,
                    borderRadius: radius.card,
                    backgroundColor: palette.border,
                  }}
                  resizeMode="cover"
                />

                {/* Caption */}
                {post.caption && (
                  <View style={{ marginTop: spacing.sm }}>
                    <Text style={{ fontSize: 14, color: palette.text }}>{post.caption}</Text>
                  </View>
                )}

                {/* Actions */}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: spacing.sm,
                    paddingTop: spacing.sm,
                    borderTopWidth: 1,
                    borderTopColor: palette.border,
                  }}
                >
                  <Text style={{ fontSize: 12, color: palette.textMuted }}>
                    Expires in {timeRemaining.toLowerCase()}
                  </Text>
                  <Pressable
                    onPress={() => handleDownload(post)}
                    disabled={isDownloading}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      backgroundColor: colors.iris600,
                      paddingHorizontal: spacing.md,
                      paddingVertical: 8,
                      borderRadius: radius.field,
                      opacity: isDownloading ? 0.6 : 1,
                    }}
                  >
                    {isDownloading ? (
                      <ActivityIndicator size="small" color={colors.white} />
                    ) : (
                      <Text style={{ color: colors.white, fontWeight: "600", fontSize: 13 }}>
                        Save to Phone
                      </Text>
                    )}
                  </Pressable>
                </View>
              </CardBox>
            </View>
          );
        }}
      />
    </Screen>
  );
}
