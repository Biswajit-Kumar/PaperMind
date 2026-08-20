import "dotenv/config";
import User from "../model/User.model.js";
import Notebook from "../model/Notebook.model.js";
import Content from "../model/Content.model.js";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { deleteCollection } from "../services/qdrant.service.js";
import { sendEmail } from "../services/email.service.js";
import fs from "fs/promises";
import path from "path";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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
      return res.status(400).json({
        message: "User already exists",
      });
    }

    const user = await User.create({
      name,
      email,
      password,
    });

    if (!user) {
      return res.status(400).json({
        message: "User not registered",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    user.verificationToken = token;

    await user.save();

    // send email
    const verifyUrl = `${
      process.env.FRONTEND_URL || "http://localhost:5173"
    }/verify/${token}`;

    await sendEmail({
      to: user.email,
      subject: "Verify ✔ your email",
      text: `Please click on the following link: ${verifyUrl}`,
      html: `<p>Please verify your email by clicking <a href="${verifyUrl}">this link</a>.</p>`,
    });

    res.status(200).json({
      message: "User registered successfully",
      success: true,
    });
  } catch (err) {
    res.status(400).json({
      message: "User not registered",
      err,
      success: false,
    });
  }
};

const verifyUser = async (req, res) => {
  const { token } = req.params;
  if (!token) {
    return res.status(400).json({
      message: "Invalid token",
    });
  }

  try {
    const user = await User.findOne({ verificationToken: token });

    if (!user) {
      return res.status(400).json({
        message: "Invalid token",
      });
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    await user.save();

    res.status(200).json({
      message: "User verified successfully",
      success: true,
    });
  } catch (err) {
    res.status(400).json({
      message: "Error verifying user",
      err,
      success: false,
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

    // Send email
    const resetUrl = `${
      process.env.FRONTEND_URL || "http://localhost:5173"
    }/reset-password/${resetToken}`;

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

    const user = await User.findById(userId).select("credits dataSourcesCount");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.status(200).json({
      success: true,
      stats: {
        credits: user.credits,
        dataSourcesCount: user.dataSourcesCount,
        maxDataSources: 20,
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
