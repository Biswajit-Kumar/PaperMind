import User from "../model/User.model.js";
import Notebook from "../model/Notebook.model.js";
import Content from "../model/Content.model.js";
import ChatMessage from "../model/ChatMessage.model.js";
import { processQuery } from "../services/chat.service.js";
import { calculateCredits } from "../services/embeddings.service.js";

// Order-independent key for a set of source IDs - must match the frontend's
// sourceSetKey() in client/src/stores/chatStore.js exactly, since it's how
// a given source combination's saved history gets found again.
const sourceKeyOf = (sourceIds) => [...sourceIds].sort().join(",");

// Controller to handle user queries against selected notebook contents
const queryDocuments = async (req, res) => {
  try {
    const { notebookId, query, selectedContentIds } = req.body;
    const userId = req.user.id;

    if (!notebookId) {
      return res.status(400).json({
        success: false,
        message: "Notebook ID is required",
      });
    }

    if (!query || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Query is required",
      });
    }

    if (!selectedContentIds || selectedContentIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one content source must be selected",
      });
    }

    // Verify notebook belongs to user
    const notebook = await Notebook.findOne({ _id: notebookId, userId });
    if (!notebook) {
      return res.status(404).json({
        success: false,
        message: "Notebook not found",
      });
    }

    // Verify all selected contents belong to user and notebook
    const contents = await Content.find({
      _id: { $in: selectedContentIds },
      userId: userId,
      notebookId: notebookId,
      status: "completed",
    });

    if (contents.length !== selectedContentIds.length) {
      return res.status(400).json({
        success: false,
        message: "Some selected contents are invalid or not processed",
      });
    }

    // Get user to check credits
    const user = await User.findById(userId);

    // Rough estimate: query length + context buffer + response
    const estimatedTokens = query.length * 2 + 1000;
    const creditsNeeded = calculateCredits(estimatedTokens);

    if (user.credits < creditsNeeded) {
      return res.status(400).json({
        success: false,
        message: "Insufficient credits for this query",
        details: {
          needed: creditsNeeded,
          available: user.credits,
        },
      });
    }

    // Process the query
    const result = await processQuery(query, selectedContentIds);

    // Calculate actual credits used
    const actualCreditsUsed = calculateCredits(result.tokensUsed.total);

    // Deduct credits
    user.credits -= actualCreditsUsed;
    await user.save();

    // Persist this exchange so it can be restored later (after logout, on
    // reselecting these same sources, etc). Best-effort: a save failure here
    // shouldn't fail a query the user already paid credits for.
    const sourceKey = sourceKeyOf(selectedContentIds);
    try {
      await ChatMessage.insertMany([
        {
          userId,
          notebookId,
          sourceKey,
          sourceIds: selectedContentIds,
          role: "user",
          content: query,
        },
        {
          userId,
          notebookId,
          sourceKey,
          sourceIds: selectedContentIds,
          role: "assistant",
          content: result.response,
          citations: result.citations,
          tokensUsed: result.tokensUsed,
          creditsDeducted: actualCreditsUsed,
        },
      ]);
    } catch (saveError) {
      console.error("Failed to save chat history:", saveError);
    }

    res.status(200).json({
      success: true,
      response: result.response,
      citations: result.citations,
      tokensUsed: result.tokensUsed,
      creditsDeducted: actualCreditsUsed,
      creditsRemaining: user.credits,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({
      success: false,
      message: "Error processing query",
      error: error.message,
    });
  }
};

// Fetch saved chat history for a notebook + exact source selection
const getChatHistory = async (req, res) => {
  try {
    const { notebookId } = req.params;
    const { sourceIds } = req.query;
    const userId = req.user.id;

    if (!notebookId || !sourceIds) {
      return res.status(400).json({
        success: false,
        message: "Notebook ID and sourceIds are required",
      });
    }

    const notebook = await Notebook.findOne({ _id: notebookId, userId });
    if (!notebook) {
      return res.status(404).json({
        success: false,
        message: "Notebook not found",
      });
    }

    const sourceKey = sourceKeyOf(sourceIds.split(","));

    const messages = await ChatMessage.find({
      userId,
      notebookId,
      sourceKey,
    }).sort({ createdAt: 1 });

    res.status(200).json({
      success: true,
      messages,
    });
  } catch (error) {
    console.error("Chat history error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching chat history",
      error: error.message,
    });
  }
};

// Delete saved chat history for a notebook + exact source selection
// (used by the explicit "clear chat" action, so it stays cleared instead of
// reappearing next time these same sources are reselected)
const deleteChatHistory = async (req, res) => {
  try {
    const { notebookId } = req.params;
    const { sourceIds } = req.query;
    const userId = req.user.id;

    if (!notebookId || !sourceIds) {
      return res.status(400).json({
        success: false,
        message: "Notebook ID and sourceIds are required",
      });
    }

    const sourceKey = sourceKeyOf(sourceIds.split(","));

    await ChatMessage.deleteMany({ userId, notebookId, sourceKey });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Chat history delete error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting chat history",
      error: error.message,
    });
  }
};

export { queryDocuments, getChatHistory, deleteChatHistory };
