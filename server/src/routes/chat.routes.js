import express from "express";
import {
  queryDocuments,
  getChatHistory,
  deleteChatHistory,
} from "../controller/chat.controller.js";
import isLoggedIn from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/query", isLoggedIn, queryDocuments);
router.get("/history/:notebookId", isLoggedIn, getChatHistory);
router.delete("/history/:notebookId", isLoggedIn, deleteChatHistory);

export default router;
