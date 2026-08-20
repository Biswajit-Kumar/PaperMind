import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";

import AuthLayout from "@/components/auth/AuthLayout";
import GoogleSignInButton from "@/components/auth/GoogleSignInButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    setValue,
    trigger,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(loginSchema),
  });

  const handleGoogleCredential = async (credential) => {
    setIsLoading(true);

    try {
      const response = await fetch("/api/v1/users/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ credential }),
      });

      const result = await response.json();

      if (result.success) {
        toast.success("Welcome!");
        navigate("/app/dashboard");
      } else {
        toast.error(result.message || "Google sign-in failed.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const onSubmit = async (data) => {
    setIsLoading(true);

    try {
      // TODO: Replace with actual API call
      const response = await fetch("/api/v1/users/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include", // Include cookies
        body: JSON.stringify({
          email: data.email,
          password: data.password,
        }),
      });

      const result = await response.json();

      if (result.success) {
        toast.success("Welcome back!");
        navigate("/app/dashboard");
      } else {
        if (result.message === "Please verify your email") {
          toast.error("Please verify your email before signing in.");
        } else {
          toast.error(result.message || "Invalid email or password.");
        }
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your PaperMind account">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* Email Field */}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="Enter your email address"
            {...register("email")}
            className={errors.email ? "border-destructive" : ""}
          />
          {errors.email && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
        </div>

        {/* Password Field */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              to="/forgot-password"
              className="text-sm text-primary hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              placeholder="Enter your password"
              {...register("password")}
              className={errors.password ? "border-destructive pr-10" : "pr-10"}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          {errors.password && (
            <p className="text-sm text-destructive">
              {errors.password.message}
            </p>
          )}
        </div>

        {/* Submit Button */}
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Signing in...
            </>
          ) : (
            "Sign in"
          )}
        </Button>

        {/* Divider */}
        <div className="relative py-2">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">Or</span>
          </div>
        </div>

        {/* Google Sign-In */}
        <GoogleSignInButton onCredential={handleGoogleCredential} />

        {/* Register Link */}
        <div className="text-center text-sm">
          <span className="text-muted-foreground">Don't have an account? </span>
          <Link
            to="/register"
            className="text-primary hover:underline font-medium"
          >
            Create account
          </Link>
        </div>
      </form>

      {/* Demo Account */}
      <div className="mt-6 p-4 bg-primary/10 border border-primary/20 rounded-lg">
        <h3 className="font-medium text-primary mb-2">Try the Demo</h3>
        <p className="text-sm text-muted-foreground mb-3">
          Want to explore PaperMind without signing up? Use our demo account.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={isLoading}
          onClick={async () => {
            setValue("email", "demo@papermind.local", {
              shouldValidate: true,
              shouldDirty: true,
            });

            setValue("password", "biswa@123", {
              shouldValidate: true,
              shouldDirty: true,
            });

            await trigger(); // clears validation errors immediately
          }}
        >
          Use Demo Account
        </Button>
      </div>
    </AuthLayout>
  );
}
