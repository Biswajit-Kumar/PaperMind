import { create } from "zustand";
import { toast } from "sonner";

// Canonical key for a set of source IDs, order-independent, used to cache
// and look up per-selection chat threads.
const sourceSetKey = (sources) => [...sources].sort().join(",");

const useChatStore = create((set, get) => ({
  messages: [],
  selectedSources: [],
  // Inactive threads, keyed by sourceSetKey, so switching away from a
  // selection and later switching back to that exact selection restores
  // the conversation instead of losing it.
  threadCache: {},
  isLoading: false,
  currentQuery: "",

  // Decides what happens to the visible chat when the selection changes:
  // - If the new selection still overlaps the current one, the current
  //   conversation continues (sources were just added/removed, same topic).
  // - If there's zero overlap, we're switching context: the current thread
  //   gets cached under its old selection so it can be restored later, and
  //   any thread previously cached under the new selection is restored (or
  //   we start fresh if none exists).
  _handleSelectionChange: (newSources) => {
    const { selectedSources: oldSources, messages, threadCache } = get();

    if (newSources.some((id) => oldSources.includes(id))) {
      set({ selectedSources: newSources });
      return;
    }

    const updatedCache = { ...threadCache };
    if (messages.length > 0) {
      updatedCache[sourceSetKey(oldSources)] = messages;
    }
    const restored = updatedCache[sourceSetKey(newSources)] || [];
    set({
      selectedSources: newSources,
      messages: restored,
      threadCache: updatedCache,
    });
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

  // Clear chat history (explicit user action - also drops the cached
  // thread for the current selection, so reselecting it won't resurrect it)
  clearChat: () => {
    const { selectedSources, threadCache } = get();
    const updatedCache = { ...threadCache };
    delete updatedCache[sourceSetKey(selectedSources)];
    set({ messages: [], threadCache: updatedCache });
  },

  // Clear all chat data
  clearChatData: () => {
    set({
      messages: [],
      selectedSources: [],
      threadCache: {},
      isLoading: false,
      currentQuery: "",
    });
  },
}));

export default useChatStore;
