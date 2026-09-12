import { useState, useEffect } from "react";
import {
  BarChart3,
  CreditCard,
  FileText,
  BookOpen,
  TrendingUp,
  Calendar,
  Activity,
  Database,
} from "lucide-react";
import { toast } from "sonner";

import useAuthStore from "@/stores/authStore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

const SOURCE_TYPE_LABELS = {
  file: "PDF / file",
  text: "Text",
  url: "Web page",
  youtube: "YouTube",
};

export default function StatsPage() {
  const { user, fetchStats } = useAuthStore();
  const [stats, setStats] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const userStats = await fetchStats();
        setStats(userStats);
      } catch {
        toast.error("Failed to load statistics");
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [fetchStats]);

  const formatDate = (value) => {
    if (!value) return "—";
    return new Date(value).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const formatNumber = (num) => {
    if (!num) return "0";
    if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
    if (num >= 1000) return (num / 1000).toFixed(1) + "K";
    return num.toString();
  };

  const getUsageLevel = (current, max) => {
    const percentage = max ? (current / max) * 100 : 0;
    if (percentage < 25) return { color: "text-green-600", level: "Low" };
    if (percentage < 50) return { color: "text-blue-600", level: "Moderate" };
    if (percentage < 75) return { color: "text-yellow-600", level: "High" };
    return { color: "text-red-600", level: "Very High" };
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-4 bg-muted rounded w-3/4 mb-2"></div>
                <div className="h-6 bg-muted rounded w-1/2 mb-4"></div>
                <div className="h-3 bg-muted rounded w-full"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const s = stats || {};
  const maxSources = s.maxDataSources || 20;
  const sourcesUsed = s.dataSourcesCount || 0;
  const monthlyCredits = s.monthlyCredits || 500;
  const totalQueries = s.totalQueries || 0;
  const avgCreditsPerQuery = s.averageCreditsPerQuery || 0;
  const hasQueryData = totalQueries > 0;

  const sourceUsageLevel = getUsageLevel(sourcesUsed, maxSources);
  const monthDelta = (s.creditsThisMonth || 0) - (s.creditsLastMonth || 0);

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
          <BarChart3 className="w-8 h-8 text-primary" />
          Usage Statistics
        </h1>
        <p className="text-muted-foreground">
          Track your PaperMind usage, credits, and activity
        </p>
      </div>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {/* Credits Remaining */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CreditCard className="w-4 h-4" />
              Credits Remaining
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground mb-2">
              {Math.floor(s.credits || 0)}
            </div>
            <p className="text-xs text-muted-foreground">
              {s.creditsUsedToday > 0
                ? `Used ${s.creditsUsedToday} today`
                : "No credits used today"}
            </p>
            {s.nextCreditResetAt && (
              <p className="text-xs text-muted-foreground">
                Refills to {monthlyCredits} on {formatDate(s.nextCreditResetAt)}
              </p>
            )}
            <Progress
              value={((s.credits || 0) / monthlyCredits) * 100}
              className="mt-3"
            />
          </CardContent>
        </Card>

        {/* Data Sources */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Database className="w-4 h-4" />
              Data Sources
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground mb-2">
              {sourcesUsed}/{maxSources}
            </div>
            <p className="text-xs text-muted-foreground">
              {maxSources - sourcesUsed} remaining
            </p>
            <Progress
              value={(sourcesUsed / maxSources) * 100}
              className="mt-3"
            />
          </CardContent>
        </Card>

        {/* Notebooks */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <BookOpen className="w-4 h-4" />
              Notebooks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground mb-2">
              {s.notebookCount || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              Total notebooks created
            </p>
          </CardContent>
        </Card>

        {/* Total Queries */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Total Queries
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground mb-2">
              {totalQueries}
            </div>
            <p className="text-xs text-muted-foreground">
              Avg {s.averageQueriesPerDay || 0}/day
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Usage Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-primary" />
              Usage Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Credit Usage */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-card-foreground">
                  Query Credit Usage
                </span>
                <span className="text-sm text-muted-foreground">
                  {s.creditsThisMonth || 0} this month
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">This Month</span>
                  <span className="text-foreground">
                    {s.creditsThisMonth || 0} credits
                  </span>
                </div>
                <Progress
                  value={Math.min(
                    ((s.creditsThisMonth || 0) / monthlyCredits) * 100,
                    100,
                  )}
                />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Last Month</span>
                  <span className="text-foreground">
                    {s.creditsLastMonth || 0} credits
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                Chat queries only; document uploads are not counted here.
              </p>
            </div>

            <Separator />

            {/* Data Sources Usage */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-card-foreground">
                  Data Sources
                </span>
                <Badge variant="outline" className={sourceUsageLevel.color}>
                  {sourceUsageLevel.level} Usage
                </Badge>
              </div>
              <Progress
                value={(sourcesUsed / maxSources) * 100}
                className="mb-2"
              />
              <p className="text-xs text-muted-foreground">
                {sourcesUsed} of {maxSources} sources used
              </p>
            </div>

            <Separator />

            {/* Performance */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-card-foreground">
                  Performance
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 text-center">
                <div className="p-3 bg-secondary/50 rounded-lg">
                  <div className="text-lg font-bold text-foreground">
                    {hasQueryData ? avgCreditsPerQuery : "—"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Credits / Query
                  </div>
                </div>
                <div className="p-3 bg-secondary/50 rounded-lg">
                  <div className="text-lg font-bold text-foreground">
                    {formatNumber(s.totalTokensProcessed || 0)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Tokens Processed
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Account Activity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5 text-primary" />
              Account Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Account Info */}
            <div>
              <h4 className="text-sm font-medium text-card-foreground mb-3">
                Account Information
              </h4>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Member Since
                  </span>
                  <span className="text-sm font-medium text-foreground">
                    {formatDate(s.memberSince || user?.createdAt)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Account Type
                  </span>
                  <Badge variant="outline">
                    {user?.role === "admin" ? "Admin" : "Standard"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Verification Status
                  </span>
                  <Badge
                    variant="outline"
                    className={
                      user?.isVerified
                        ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300"
                        : "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300"
                    }
                  >
                    {user?.isVerified ? "Verified" : "Pending"}
                  </Badge>
                </div>
              </div>
            </div>

            <Separator />

            {/* Usage Stats */}
            <div>
              <h4 className="text-sm font-medium text-card-foreground mb-3">
                Usage Statistics
              </h4>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Documents Processed
                  </span>
                  <span className="text-sm font-medium text-foreground">
                    {s.documentsProcessed || 0}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Most Used Source Type
                  </span>
                  <span className="text-sm font-medium text-foreground">
                    {SOURCE_TYPE_LABELS[s.favoriteSourceType] || "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Avg. Queries / Day
                  </span>
                  <span className="text-sm font-medium text-foreground">
                    {s.averageQueriesPerDay || 0}
                  </span>
                </div>
              </div>
            </div>

            <Separator />

            {/* Recent Activity */}
            <div>
              <h4 className="text-sm font-medium text-card-foreground mb-3">
                Recent Activity
              </h4>
              <div className="space-y-2">
                <div className="flex items-center gap-3 p-2 bg-secondary/30 rounded-lg">
                  <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                  <div className="flex-1">
                    <p className="text-xs font-medium text-foreground">
                      This Session
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(new Date())}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-2 bg-secondary/30 rounded-lg">
                  <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                  <div className="flex-1">
                    <p className="text-xs font-medium text-foreground">
                      Last Query
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.lastQueryAt
                        ? formatDate(s.lastQueryAt)
                        : "No queries yet"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-2 bg-secondary/30 rounded-lg">
                  <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                  <div className="flex-1">
                    <p className="text-xs font-medium text-foreground">
                      Last Source Added
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.lastContentAt
                        ? formatDate(s.lastContentAt)
                        : "No content yet"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Metrics */}
      <div className="mt-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" />
              Detailed Metrics
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {/* Credit Efficiency */}
              <div className="text-center p-4 border border-border rounded-lg">
                <div className="text-2xl font-bold text-primary mb-1">
                  {hasQueryData ? avgCreditsPerQuery : "—"}
                </div>
                <div className="text-sm text-muted-foreground mb-2">
                  Avg Credits per Query
                </div>
                <div className="text-xs text-muted-foreground">
                  {!hasQueryData
                    ? "No queries yet"
                    : avgCreditsPerQuery <= 2
                      ? "Efficiency: Excellent"
                      : avgCreditsPerQuery <= 3
                        ? "Efficiency: Good"
                        : "Efficiency: Fair"}
                </div>
              </div>

              {/* Token Processing */}
              <div className="text-center p-4 border border-border rounded-lg">
                <div className="text-2xl font-bold text-green-600 dark:text-green-400 mb-1">
                  {formatNumber(s.totalTokensProcessed || 0)}
                </div>
                <div className="text-sm text-muted-foreground mb-2">
                  Total Tokens Processed
                </div>
                <div className="text-xs text-muted-foreground">
                  Embeddings + chat
                </div>
              </div>

              {/* Monthly Usage */}
              <div className="text-center p-4 border border-border rounded-lg">
                <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 mb-1">
                  {s.creditsThisMonth || 0}
                </div>
                <div className="text-sm text-muted-foreground mb-2">
                  Query Credits This Month
                </div>
                <div className="text-xs text-muted-foreground">
                  {monthDelta === 0
                    ? "Same as last month"
                    : monthDelta > 0
                      ? `↑ ${monthDelta} vs last month`
                      : `↓ ${Math.abs(monthDelta)} vs last month`}
                </div>
              </div>

              {/* Document Processing */}
              <div className="text-center p-4 border border-border rounded-lg">
                <div className="text-2xl font-bold text-purple-600 dark:text-purple-400 mb-1">
                  {s.documentsProcessed || 0}
                </div>
                <div className="text-sm text-muted-foreground mb-2">
                  Documents Processed
                </div>
                <div className="text-xs text-muted-foreground">
                  Knowledge Base Size
                </div>
              </div>
            </div>

            {/* Usage Insights */}
            <div className="mt-6 p-4 bg-primary/5 border border-primary/20 rounded-lg">
              <h4 className="text-sm font-semibold text-primary mb-2 flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                Usage Insights
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">
                    • You have{" "}
                    <strong className="text-foreground">
                      {Math.floor(s.credits || 0)} credits
                    </strong>{" "}
                    remaining
                  </p>
                  <p className="text-muted-foreground">
                    • You can add{" "}
                    <strong className="text-foreground">
                      {maxSources - sourcesUsed} more
                    </strong>{" "}
                    data sources
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">
                    • Your avg query uses{" "}
                    <strong className="text-foreground">
                      {hasQueryData ? `${avgCreditsPerQuery} credits` : "n/a yet"}
                    </strong>
                  </p>
                  <p className="text-muted-foreground">
                    • Most used source type:{" "}
                    <strong className="text-foreground">
                      {SOURCE_TYPE_LABELS[s.favoriteSourceType] || "none yet"}
                    </strong>
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tips and Recommendations */}
      <div className="mt-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              💡 Tips & Recommendations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                <h5 className="font-medium text-blue-900 dark:text-blue-100 mb-2">
                  Credit Optimization
                </h5>
                <p className="text-sm text-blue-700 dark:text-blue-300">
                  {!hasQueryData
                    ? "Ask your first question to see how efficiently your queries use credits."
                    : avgCreditsPerQuery > 3
                      ? "Try asking more specific questions to reduce credit usage per query."
                      : "Your queries are credit-efficient."}
                </p>
              </div>

              <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                <h5 className="font-medium text-green-900 dark:text-green-100 mb-2">
                  Content Management
                </h5>
                <p className="text-sm text-green-700 dark:text-green-300">
                  {sourcesUsed === 0
                    ? "Upload a document or add a URL to build your first knowledge base."
                    : sourcesUsed < 10
                      ? "You can add more documents to build a richer knowledge base."
                      : "Your knowledge base is well-stocked! Focus on quality queries."}
                </p>
              </div>

              <div className="p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg">
                <h5 className="font-medium text-purple-900 dark:text-purple-100 mb-2">
                  Usage Patterns
                </h5>
                <p className="text-sm text-purple-700 dark:text-purple-300">
                  {s.averageQueriesPerDay > 10
                    ? "You're an active user! Consider organizing content into more notebooks."
                    : "Try exploring more queries to get the most out of your content."}
                </p>
              </div>

              <div className="p-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
                <h5 className="font-medium text-orange-900 dark:text-orange-100 mb-2">
                  Feature Discovery
                </h5>
                <p className="text-sm text-orange-700 dark:text-orange-300">
                  {(s.notebookCount || 0) < 3
                    ? "Create separate notebooks for different topics to stay organized."
                    : "Excellent organization! Use the chat feature to get detailed answers."}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
