import { useCallback, useMemo, useState } from "react";
import { Smile } from "lucide-react";
import type { Reaction, ReactionContent } from "../contexts/github";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../cn";

const REACTION_EMOJIS: Record<ReactionContent, string> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

const REACTION_ORDER: ReactionContent[] = [
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
];

function formatUsersTooltip(users: string[], emoji: string) {
  if (users.length === 0) return "";
  if (users.length === 1) return `${users[0]} reacted with ${emoji}`;
  if (users.length === 2)
    return `${users[0]} and ${users[1]} reacted with ${emoji}`;
  if (users.length === 3)
    return `${users[0]}, ${users[1]}, and ${users[2]} reacted with ${emoji}`;
  return `${users[0]}, ${users[1]}, and ${users.length - 2} others reacted with ${emoji}`;
}

interface EmojiReactionsProps {
  reactions: Reaction[];
  onAddReaction?: (content: ReactionContent) => void;
  onRemoveReaction?: (reactionId: number) => void;
  currentUser?: string | null;
  /** Compact size used in inline review comments; default false (overview size). */
  compact?: boolean;
}

export function EmojiReactions({
  reactions,
  onAddReaction,
  onRemoveReaction,
  currentUser,
  compact = false,
}: EmojiReactionsProps) {
  const [showPicker, setShowPicker] = useState(false);

  const groupedReactions = useMemo(() => {
    const groups: Record<
      string,
      { count: number; users: string[]; userReactionId?: number }
    > = {};

    for (const reaction of reactions) {
      const content = reaction.content as ReactionContent;
      if (!groups[content]) {
        groups[content] = { count: 0, users: [] };
      }
      groups[content].count++;
      if (reaction.user?.login) {
        groups[content].users.push(reaction.user.login);
        if (reaction.user.login === currentUser) {
          groups[content].userReactionId = reaction.id;
        }
      }
    }

    return groups;
  }, [reactions, currentUser]);

  const handleReactionClick = useCallback(
    (content: ReactionContent) => {
      const group = groupedReactions[content];
      if (group?.userReactionId && onRemoveReaction) {
        onRemoveReaction(group.userReactionId);
      } else if (onAddReaction) {
        onAddReaction(content);
      }
      setShowPicker(false);
    },
    [groupedReactions, onAddReaction, onRemoveReaction]
  );

  const sortedReactions = useMemo(() => {
    return REACTION_ORDER.filter(
      (content) => groupedReactions[content]?.count > 0
    );
  }, [groupedReactions]);

  if (!onAddReaction && sortedReactions.length === 0) {
    return null;
  }

  const triggerSize = compact ? "w-6 h-6" : "w-7 h-7";
  const triggerIconSize = compact ? "w-3.5 h-3.5" : "w-4 h-4";
  const pillSize = compact ? "gap-1 px-2 py-0.5" : "gap-1.5 px-2.5 py-1";

  return (
    <div
      className="flex items-center gap-1.5 flex-wrap"
      style={compact ? { fontFamily: "var(--font-sans)" } : undefined}
    >
      {onAddReaction && (
        <Popover open={showPicker} onOpenChange={setShowPicker}>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    className={cn(
                      "inline-flex items-center justify-center text-xs rounded-full border border-border hover:border-blue-500/50 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors",
                      triggerSize
                    )}
                  >
                    <Smile className={triggerIconSize} />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Add reaction</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <PopoverContent align="start" className="w-auto p-2 flex gap-1">
            {REACTION_ORDER.map((content) => (
              <button
                key={content}
                onClick={() => handleReactionClick(content)}
                className={cn(
                  "w-8 h-8 flex items-center justify-center text-lg rounded hover:bg-muted transition-colors",
                  groupedReactions[content]?.userReactionId && "bg-blue-500/20"
                )}
                title={content}
              >
                {REACTION_EMOJIS[content]}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      )}

      <TooltipProvider delayDuration={200}>
        {sortedReactions.map((content) => {
          const group = groupedReactions[content];
          const isUserReaction = !!group.userReactionId;

          return (
            <Tooltip key={content}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => handleReactionClick(content)}
                  className={cn(
                    "inline-flex items-center text-xs rounded-full border transition-colors",
                    pillSize,
                    isUserReaction
                      ? "bg-blue-500/20 border-blue-500/50 text-blue-400"
                      : "bg-muted/50 border-border hover:border-blue-500/50"
                  )}
                >
                  <span>{REACTION_EMOJIS[content]}</span>
                  <span>{group.count}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {formatUsersTooltip(group.users, REACTION_EMOJIS[content])}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </TooltipProvider>
    </div>
  );
}
