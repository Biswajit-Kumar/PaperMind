import "dotenv/config";
import mongoose from "mongoose";
import User from "../model/User.model.js";
import Notebook from "../model/Notebook.model.js";
import Content from "../model/Content.model.js";
import ChatMessage from "../model/ChatMessage.model.js";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { deleteCollection } from "../services/qdrant.service.js";
import { sendEmail } from "../services/email.service.js";
import fs from "fs/promises";
import path from "path";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Monthly credit allowance and the rolling window it refills on.
const MONTHLY_CREDITS = parseInt(process.env.MONTHLY_CREDITS) || 500;
const CREDIT_RESET_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

// Lazy "monthly" credit refill: no cron - every login / profile fetch checks
// whether it's been 30+ days since the last refill and, if so, tops the user
// back up. Uses Math.max so a light user who still has credits left is never
// reset downward. Returns the (possibly updated) user.
const refillCreditsIfDue = async (user) => {
  const last = user.creditsResetAt ? user.creditsResetAt.getTime() : 0;
  if (Date.now() - last >= CREDIT_RESET_INTERVAL_MS) {
    user.credits = Math.max(user.credits, MONTHLY_CREDITS);
    user.creditsResetAt = new Date();
    await user.save();
  }
  return user;
};

// When the current allowance window will next refill.
const nextCreditReset = (user) =>
  new Date(
    (user.creditsResetAt ? user.creditsResetAt.getTime() : Date.now()) +
      CREDIT_RESET_INTERVAL_MS,
  );

// Public base URLs. Trailing slash trimmed so `${URL}/path` never doubles up.
const FRONTEND_URL = (
  process.env.FRONTEND_URL || "http://localhost:5173"
).replace(/\/$/, "");

// Where the email verification link points - deliberately the backend (which
// serves its own confirmation page), so the link never depends on the Vite
// dev server's port / interface / SPA router.
//   - locally: hit the backend port directly (no Vite in the path)
//   - in prod: FRONTEND_URL is a real domain whose /api/* is proxied to this
//     backend (see client/vercel.json), so route through it - which means a
//     phone, or any device, gets a working public https link.
// Override with SERVER_URL if the backend has its own public URL.
const SERVER_URL = (
  process.env.SERVER_URL ||
  (FRONTEND_URL.includes("localhost") ? "http://localhost:3000" : FRONTEND_URL)
).replace(/\/$/, "");

// Minimal self-contained result page for links clicked from an email, so the
// browser renders something sensible with zero frontend dependency.
const resultPage = ({ ok, title, message }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · PaperMind</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0f0f10;color:#e7e7e7;display:grid;place-items:center;min-height:100vh;margin:0}
  .card{max-width:420px;padding:2.5rem 2rem;text-align:center}
  .icon{font-size:3rem;line-height:1}
  h1{font-size:1.3rem;margin:.9rem 0 .5rem}
  p{color:#9a9a9a;line-height:1.55;margin:0 0 1.6rem}
  a.btn{display:inline-block;background:#f5a623;color:#111;text-decoration:none;font-weight:600;padding:.7rem 1.5rem;border-radius:8px}
</style></head><body>
<div class="card">
  <div class="icon">${ok ? "✅" : "⚠️"}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <a class="btn" href="${FRONTEND_URL}/login">Go to login</a>
</div></body></html>`;

// Signs and cookies a JWT for a user the same way normal login does
const issueSession = (res, user) => {
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRY,
  });

  res.cookie("token", token, {
    httpOnly: true,
    secure: true,
    maxAge: 24 * 60 * 60 * 1000,
  });

  return token;
};

// Shared by registration and manual resend - (re)issues a verification token
// and emails it. Returns { ok: true } or { ok: false } so callers can decide
// how to respond without this throwing past them.
const sendVerificationEmail = async (user) => {
  const token = crypto.randomBytes(32).toString("hex");
  user.verificationToken = token;
  await user.save();

  // Points at the backend (always running - it's what sends this email), which
  // serves its own confirmation page. No dependency on the frontend dev server.
  const verifyUrl = `${SERVER_URL}/api/v1/users/verify/${token}`;

  try {
    await sendEmail({
      to: user.email,
      subject: "Verify ✔ your email",
      text: `Please click on the following link: ${verifyUrl}`,
      html: `<p>Please verify your email by clicking <a href="${verifyUrl}">this link</a>.</p>`,
    });
    return { ok: true };
  } catch (emailErr) {
    console.error("Verification email send failed:", emailErr);
    return { ok: false };
  }
};

const registerUser = async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({
      message: "All fields are required",
    });
  }

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      if (existingUser.isVerified) {
        return res.status(400).json({
          message: "User already exists",
        });
      }

      // Account exists from a previous attempt but was never verified -
      // most likely because the verification email failed to send. Re-send
      // instead of dead-ending the user in an unrecoverable "already exists".
      const { ok } = await sendVerificationEmail(existingUser);
      return res.status(200).json({
        message: ok
          ? "This account already exists but isn't verified yet. We've sent a new verification email."
          : "This account already exists but isn't verified, and the verification email failed to send again. Please try again shortly.",
        success: ok,
      });
    }

    const user = await User.create({
      name,
      email,
      password,
    });

    const { ok } = await sendVerificationEmail(user);

    res.status(200).json({
      message: ok
        ? "User registered successfully"
        : "Account created, but the verification email could not be sent. Please try registering again to get a new verification email.",
      success: true,
      emailFailed: !ok,
    });
  } catch {
    res.status(400).json({
      message: "Registration failed",
      success: false,
    });
  }
};

const verifyUser = async (req, res) => {
  const { token } = req.params;

  // Clicked from an email -> browser sends Accept: text/html -> render a page.
  // Called programmatically (old frontend route, tests) -> JSON.
  const wantsHtml = req.accepts(["json", "html"]) === "html";
  const respond = (status, { ok, apiMessage, title, message }) =>
    wantsHtml
      ? res.status(status).type("html").send(resultPage({ ok, title, message }))
      : res.status(status).json({ success: ok, message: apiMessage });

  if (!token) {
    return respond(400, {
      ok: false,
      apiMessage: "Invalid token",
      title: "Invalid link",
      message: "This verification link is missing its token.",
    });
  }

  try {
    const user = await User.findOne({ verificationToken: token });

    if (!user) {
      return respond(400, {
        ok: false,
        apiMessage: "Invalid token",
        title: "Link expired or already used",
        message:
          "This verification link is no longer valid. If you already verified, just log in - otherwise register again to get a fresh link.",
      });
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    await user.save();

    return respond(200, {
      ok: true,
      apiMessage: "User verified successfully",
      title: "Email verified",
      message: "Your email is confirmed. You can now log in to PaperMind.",
    });
  } catch (err) {
    console.error("Verify error:", err);
    return respond(400, {
      ok: false,
      apiMessage: "Error verifying user",
      title: "Something went wrong",
      message:
        "We couldn't verify your email just now. Please try the link again in a moment.",
    });
  }
};

const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      message: "All fields are required",
    });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({
        message: "Invalid email or password",
      });
    }

    if (user.authProvider === "google") {
      return res.status(400).json({
        message: "This account uses Google sign-in - use the Google button instead",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        message: "Invalid email or password",
      });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        message: "Please verify your email",
      });
    }

    await refillCreditsIfDue(user);

    const token = issueSession(res, user);

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
      },
    });
  } catch (err) {
    res.status(400).json({
      message: "Error logging in",
      err,
      success: false,
    });
  }
};

// Sign in (or sign up, on first use) with a Google ID token obtained by the
// frontend's Google Identity Services button. Google has already verified
// the user's email, so these accounts skip our own verification step.
const googleAuthUser = async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({
      success: false,
      message: "Google credential is required",
    });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    let user = await User.findOne({
      $or: [{ googleId: payload.sub }, { email: payload.email }],
    });

    if (user) {
      // A local account with this email is signing in with Google for the
      // first time - link it rather than creating a duplicate.
      if (!user.googleId) {
        user.googleId = payload.sub;
        user.authProvider = "google";
        user.isVerified = true;
        await user.save();
      }
    } else {
      user = await User.create({
        name: payload.name,
        email: payload.email,
        googleId: payload.sub,
        authProvider: "google",
        isVerified: true,
      });
    }

    await refillCreditsIfDue(user);

    const token = issueSession(res, user);

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
      },
    });
  } catch (err) {
    res.status(401).json({
      success: false,
      message: "Google sign-in failed",
      err: err.message,
    });
  }
};

const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "User not found",
      });
    }

    await refillCreditsIfDue(user);

    res.status(200).json({
      success: true,
      user,
    });
  } catch (err) {
    res.status(400).json({
      message: "Error getting user profile",
      err,
      success: false,
    });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { name } = req.body;
    const userId = req.user.id;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Name is required",
      });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      {
        name: name.trim(),
      },
      { new: true, runValidators: true },
    ).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Error updating profile",
      error: err.message,
    });
  }
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters long",
      });
    }

    // Get user with password field
    const user = await User.findById(userId).select("+password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(
      currentPassword,
      user.password,
    );

    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    // Update password (will be hashed by pre-save middleware)
    user.password = newPassword;
    await user.save();

    res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Error changing password",
      error: err.message,
    });
  }
};

const deleteAccount = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user to confirm existence
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const contents = await Content.find({ userId });

    // Delete all Qdrant collections
    for (const content of contents) {
      if (content.qdrantCollectionName) {
        try {
          await deleteCollection(content._id);
        } catch (error) {
          console.error(
            `Failed to delete Qdrant collection for content ${content._id}:`,
            error,
          );
          // Continue with deletion even if Qdrant cleanup fails
        }
      }
    }

    // Delete all uploaded files
    for (const content of contents) {
      if (content.sourceType === "file" && content.sourceData.filePath) {
        try {
          await fs.unlink(content.sourceData.filePath);
        } catch {
          console.log(
            `File already deleted or not found: ${content.sourceData.filePath}`,
          );
        }
      }
    }

    // Delete user's upload directory
    const uploadDir = path.join("uploads", `user_${userId}`);
    try {
      await fs.rm(uploadDir, { recursive: true, force: true });
    } catch {
      console.log(
        `Upload directory not found or already deleted: ${uploadDir}`,
      );
    }

    // Delete all contents
    await Content.deleteMany({ userId });

    // Delete all notebooks
    await Notebook.deleteMany({ userId });

    // Finally, delete the user
    await User.findByIdAndDelete(userId);

    // Clear the authentication cookie
    res.cookie("token", null, {
      expires: new Date(Date.now()),
      httpOnly: true,
    });

    res.status(200).json({
      success: true,
      message: "Account deleted successfully",
    });
  } catch (err) {
    console.error("Error deleting account:", err);
    res.status(500).json({
      success: false,
      message: "Error deleting account",
      error: err.message,
    });
  }
};

const logout = async (req, res) => {
  try {
    res.cookie("token", null, {
      expires: new Date(Date.now()),
    });

    res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (err) {
    res.status(400).json({
      message: "Error logout user",
      err,
      success: false,
    });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        message: "Email is required",
        success: false,
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        message: "User not found",
        success: false,
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 10 * 60 * 1000; // 10 minutes

    await user.save();

    // Send email. Reset needs the frontend form (to type a new password), so
    // this link does point at the frontend - unlike email verification.
    const resetUrl = `${FRONTEND_URL}/reset-password/${resetToken}`;

    await sendEmail({
      to: user.email,
      subject: "Password Reset Request",
      text: `Please click on the following link to reset your password: ${resetUrl}`,
      html: `<p>Please reset your password by clicking <a href="${resetUrl}">this link</a>.</p><p>This link expires in 10 minutes.</p>`,
    });

    res.status(200).json({
      message: "Password reset email sent successfully",
      success: true,
    });
  } catch (err) {
    res.status(500).json({
      message: "Error sending password reset email",
      err: err.message,
      success: false,
    });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        message: "Password is required",
        success: false,
      });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        message: "Invalid or expired reset token",
        success: false,
      });
    }

    // Update password
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    res.status(200).json({
      message: "Password reset successfully",
      success: true,
    });
  } catch (err) {
    res.status(500).json({
      message: "Error resetting password",
      err: err.message,
      success: false,
    });
  }
};

const getUserStats = async (req, res) => {
  try {
    const userId = req.user.id;
    const uid = new mongoose.Types.ObjectId(userId);

    const user = await User.findById(userId).select(
      "credits dataSourcesCount creditsResetAt createdAt",
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    await refillCreditsIfDue(user);

    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // creditsDeducted lives on the assistant message of each exchange.
    const spendSince = (from, to) =>
      ChatMessage.aggregate([
        {
          $match: {
            userId: uid,
            role: "assistant",
            ...(from || to
              ? { createdAt: { ...(from && { $gte: from }), ...(to && { $lt: to }) } }
              : {}),
          },
        },
        { $group: { _id: null, credits: { $sum: "$creditsDeducted" } } },
      ]);

    const [
      notebookCount,
      contentAgg,
      sourceTypeAgg,
      totalQueries,
      answeredAgg,
      todayAgg,
      thisMonthAgg,
      lastMonthAgg,
      lastQuery,
      lastContent,
    ] = await Promise.all([
      Notebook.countDocuments({ userId: uid }),
      Content.aggregate([
        { $match: { userId: uid } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            tokens: { $sum: "$tokensUsed" },
          },
        },
      ]),
      Content.aggregate([
        { $match: { userId: uid } },
        { $group: { _id: "$sourceType", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 },
      ]),
      ChatMessage.countDocuments({ userId: uid, role: "user" }),
      ChatMessage.aggregate([
        { $match: { userId: uid, role: "assistant" } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            credits: { $sum: "$creditsDeducted" },
            tokens: { $sum: "$tokensUsed.total" },
          },
        },
      ]),
      spendSince(startOfToday, null),
      spendSince(startOfThisMonth, null),
      spendSince(startOfLastMonth, startOfThisMonth),
      ChatMessage.findOne({ userId: uid, role: "user" })
        .sort({ createdAt: -1 })
        .select("createdAt"),
      Content.findOne({ userId: uid }).sort({ createdAt: -1 }).select("createdAt"),
    ]);

    const pick = (arr, key) => (arr[0] ? arr[0][key] || 0 : 0);

    const documentsProcessed = pick(contentAgg, "count");
    const answeredQueries = pick(answeredAgg, "count");
    const querySpend = pick(answeredAgg, "credits");
    const totalTokensProcessed =
      pick(contentAgg, "tokens") + pick(answeredAgg, "tokens");

    const daysSinceSignup = Math.max(
      1,
      Math.ceil((now - new Date(user.createdAt)) / (24 * 60 * 60 * 1000)),
    );

    res.status(200).json({
      success: true,
      stats: {
        // Credits
        credits: user.credits,
        monthlyCredits: MONTHLY_CREDITS,
        creditsResetAt: user.creditsResetAt,
        nextCreditResetAt: nextCreditReset(user),
        creditsUsedToday: Math.round(pick(todayAgg, "credits") * 100) / 100,
        creditsThisMonth: Math.round(pick(thisMonthAgg, "credits") * 100) / 100,
        creditsLastMonth: Math.round(pick(lastMonthAgg, "credits") * 100) / 100,
        // Sources & notebooks
        dataSourcesCount: user.dataSourcesCount,
        maxDataSources: 20,
        notebookCount,
        documentsProcessed,
        favoriteSourceType: sourceTypeAgg[0] ? sourceTypeAgg[0]._id : null,
        // Queries
        totalQueries,
        averageQueriesPerDay:
          Math.round((totalQueries / daysSinceSignup) * 10) / 10,
        averageCreditsPerQuery:
          answeredQueries > 0
            ? Math.round((querySpend / answeredQueries) * 100) / 100
            : 0,
        totalTokensProcessed,
        // Activity
        memberSince: user.createdAt,
        lastQueryAt: lastQuery ? lastQuery.createdAt : null,
        lastContentAt: lastContent ? lastContent.createdAt : null,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching user stats",
      error: error.message,
    });
  }
};

export {
  registerUser,
  verifyUser,
  login,
  googleAuthUser,
  getProfile,
  updateProfile,
  changePassword,
  deleteAccount,
  logout,
  forgotPassword,
  resetPassword,
  getUserStats,
};
