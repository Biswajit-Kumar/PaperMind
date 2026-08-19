import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    notebookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Notebook",
      required: true,
    },
    // Canonical, order-independent key for the set of sources this message's
    // conversation was built on (sorted content IDs, comma-joined) - mirrors
    // the frontend's per-selection thread caching so a given source
    // combination's history can be fetched back exactly.
    sourceKey: {
      type: String,
      required: true,
    },
    sourceIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Content",
      },
    ],
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    citations: {
      type: [mongoose.Schema.Types.Mixed],
      default: undefined,
    },
    tokensUsed: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    creditsDeducted: Number,
  },
  { timestamps: true }
);

chatMessageSchema.index({ userId: 1, notebookId: 1, sourceKey: 1, createdAt: 1 });

const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);

export default ChatMessage;
