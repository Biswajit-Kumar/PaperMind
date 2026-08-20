import { useEffect } from "react";
import { MessageSquarePlus, MessagesSquare, Loader2 } from "lucide-react";
import useChatStore from "@/stores/chatStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

const formatWhen = (isoString) => {
  const date = new Date(isoString);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const wasYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (sameDay) return time;
  if (wasYesterday) return `Yesterday, ${time}`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export default function ChatHistoryPanel({ notebookId }) {
  const {
    threads,
    isLoadingThreads,
    selectedSources,
    fetchThreads,
    setSelectedSources,
  } = useChatStore();

  useEffect(() => {
    if (notebookId) fetchThreads(notebookId);
  }, [notebookId, fetchThreads]);

  const activeKey = [...selectedSources].sort().join(",");

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 border-b border-border">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start"
          onClick={() => setSelectedSources([])}
        >
          <MessageSquarePlus className="h-4 w-4 mr-2" />
          New chat
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {isLoadingThreads ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : threads.length === 0 ? (
            <div className="text-center py-8 px-4">
              <MessagesSquare className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No conversations yet. Select a source and ask a question to
                get started.
              </p>
            </div>
          ) : (
            threads.map((thread) => (
              <button
                key={thread.sourceKey}
                onClick={() => setSelectedSources(thread.sourceIds)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                  thread.sourceKey === activeKey
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50 text-foreground"
                }`}
              >
                <p className="truncate font-medium">{thread.title}</p>
                <div className="flex items-center justify-between mt-0.5 text-xs text-muted-foreground">
                  <span>{formatWhen(thread.lastMessageAt)}</span>
                  <span>
                    {thread.messageCount} message
                    {thread.messageCount !== 1 ? "s" : ""}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
