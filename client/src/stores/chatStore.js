import { create } from "zustand";
import { toast } from "sonner";

// Canonical key for a set of source IDs, order-independent, used to cache
// and look up per-selection chat threads. Must match sourceKeyOf() in
// server/src/controller/chat.controller.js exactly.
const sourceSetKey = (sources) => [...sources].sort().join(",");

// Maps a saved ChatMessage document (Mongo _id/createdAt) to the shape the
// UI already expects (id/timestamp), so restored history renders identically
// to messages just sent in this session.
const fromSavedMessage = (doc) => ({
  id: doc._id,
  role: doc.role,
  content: doc.content,
  citations: doc.citations,
  tokensUsed: doc.tokensUsed,
  creditsDeducted: doc.creditsDeducted,
  timestamp: doc.createdAt,
});

const fetchHistory = async (notebookId, sources) => {
  const res = await fetch(
    `/api/v1/chat/history/${notebookId}?sourceIds=${sources.join(",")}`,
    { credentials: "include" },
  );
  if (!res.ok) return [];
  const result = await res.json();
  return result.success ? result.messages.map(fromSavedMessage) : [];
};

const useChatStore = create((set, get) => ({
  currentNotebookId: null,
  messages: [],
  selectedSources: [],
  // Inactive threads, keyed by sourceSetKey, so switching away from a
  // selection and later switching back to that exact selection restores
  // the conversation instead of losing it. A session-local fast path in
  // front of the persisted (database-backed) history.
  threadCache: {},
  // Sidebar list: one entry per distinct source-selection ever chatted
  // with in this notebook, newest first. Separate from threadCache, which
  // holds the actual messages.
  threads: [],
  isLoadingThreads: false,
  isLoading: false,
  isLoadingHistory: false,
  currentQuery: "",

  // Call when entering a notebook, so history fetches know which notebook
  // to ask about, and so switching notebooks doesn't bleed chat state.
  setCurrentNotebook: (notebookId) => {
    set({
      currentNotebookId: notebookId,
      messages: [],
      selectedSources: [],
      threadCache: {},
      threads: [],
    });
    get().fetchThreads(notebookId);
  },

  fetchThreads: async (notebookId) => {
    set({ isLoadingThreads: true });
    try {
      const res = await fetch(`/api/v1/chat/threads/${notebookId}`, {
        credentials: "include",
      });
      const result = await res.json();
      set({
        threads: result.success ? result.threads : [],
        isLoadingThreads: false,
      });
    } catch {
      set({ isLoadingThreads: false });
    }
  },

  // Decides what happens to the visible chat when the selection changes:
  // - If the new selection still overlaps the current one, the current
  //   conversation continues (sources were just added/removed, same topic).
  // - If there's zero overlap, we're switching context: the current thread
  //   gets cached under its old selection, and the new selection's thread is
  //   restored from the local cache if present, otherwise fetched from the
  //   server (a prior session may have saved history for it).
  _handleSelectionChange: async (newSources) => {
    const { selectedSources: oldSources, messages, threadCache, currentNotebookId } = get();

    if (newSources.some((id) => oldSources.includes(id))) {
      set({ selectedSources: newSources });
      return;
    }

    const updatedCache = { ...threadCache };
    if (messages.length > 0) {
      updatedCache[sourceSetKey(oldSources)] = messages;
    }

    const newKey = sourceSetKey(newSources);
    if (newKey in updatedCache) {
      set({
        selectedSources: newSources,
        messages: updatedCache[newKey],
        threadCache: updatedCache,
      });
      return;
    }

    set({
      selectedSources: newSources,
      messages: [],
      threadCache: updatedCache,
      isLoadingHistory: newSources.length > 0,
    });

    if (newSources.length === 0 || !currentNotebookId) return;

    const restored = await fetchHistory(currentNotebookId, newSources);

    // Only apply if the selection hasn't changed again while this was in flight
    if (sourceSetKey(get().selectedSources) === newKey) {
      set((state) => ({
        messages: restored,
        threadCache: { ...state.threadCache, [newKey]: restored },
        isLoadingHistory: false,
      }));
    }
  },

  setSelectedSources: (sources) => {
    get()._handleSelectionChange(sources);
  },

  addSelectedSource: (sourceId) => {
    const currentSources = get().selectedSources;
    if (!currentSources.includes(sourceId)) {
      get()._handleSelectionChange([...currentSources, sourceId]);
    }
  },

  removeSelectedSource: (sourceId) => {
    const currentSources = get().selectedSources;
    get()._handleSelectionChange(
      currentSources.filter((id) => id !== sourceId),
    );
  },

  addMessage: (message) => {
    const currentMessages = get().messages;
    set({ messages: [...currentMessages, message] });
  },

  sendQuery: async (notebookId, query) => {
    const { selectedSources } = get();

    if (selectedSources.length === 0) {
      toast.error("Please select at least one content source");
      return { success: false };
    }

    // Add user message
    const userMessage = {
      id: Date.now().toString(),
      role: "user",
      content: query,
      timestamp: new Date(),
    };

    get().addMessage(userMessage);
    set({ currentQuery: query, isLoading: true });

    try {
      const response = await fetch("/api/v1/chat/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          notebookId,
          query,
          selectedContentIds: selectedSources,
        }),
      });

      const result = await response.json();

      if (result.success) {
        // Add assistant message
        const assistantMessage = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: result.response,
          citations: result.citations,
          tokensUsed: result.tokensUsed,
          creditsDeducted: result.creditsDeducted,
          timestamp: new Date(),
        };

        get().addMessage(assistantMessage);

        // Keep the thread cache in sync so switching away and back within
        // this session (before a server round-trip) still sees this reply.
        set((state) => ({
          threadCache: {
            ...state.threadCache,
            [sourceSetKey(selectedSources)]: state.messages,
          },
        }));

        // Update user credits in auth store if available
        if (window.useAuthStore) {
          const authStore = window.useAuthStore.getState();
          if (authStore.user) {
            authStore.setUser({
              ...authStore.user,
              credits: result.creditsRemaining,
            });
          }
        }

        set({ currentQuery: "", isLoading: false });
        get().fetchThreads(notebookId);
        return { success: true, response: result.response };
      } else {
        toast.error(result.message || "Failed to process query");
        set({ isLoading: false });
        return { success: false, error: result.message };
      }
    } catch {
      toast.error("Failed to send message");
      set({ isLoading: false });
      return { success: false, error: "Network error" };
    }
  },

  // Clear chat history (explicit user action). Deletes it server-side too,
  // and drops the cached thread for the current selection, so reselecting
  // these same sources later won't resurrect it.
  clearChat: async () => {
    const { selectedSources, threadCache, currentNotebookId } = get();
    const updatedCache = { ...threadCache };
    delete updatedCache[sourceSetKey(selectedSources)];
    set({ messages: [], threadCache: updatedCache });

    if (currentNotebookId && selectedSources.length > 0) {
      try {
        await fetch(
          `/api/v1/chat/history/${currentNotebookId}?sourceIds=${selectedSources.join(",")}`,
          { method: "DELETE", credentials: "include" },
        );
        get().fetchThreads(currentNotebookId);
      } catch {
        // Local state is already cleared; a failed server delete just means
        // the history could reappear on a future reselect - not fatal.
      }
    }
  },

  // Clear all chat data
  clearChatData: () => {
    set({
      currentNotebookId: null,
      messages: [],
      selectedSources: [],
      threadCache: {},
      threads: [],
      isLoadingThreads: false,
      isLoading: false,
      isLoadingHistory: false,
      currentQuery: "",
    });
  },
}));

export default useChatStore;
