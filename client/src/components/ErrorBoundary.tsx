import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors so a single broken component doesn't
 * blank the entire page. Shows the error stack and a reset button.
 *
 * Without this, any uncaught exception in React 18+ unmounts the entire
 * tree — users just see a white screen with no clue what went wrong.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);

    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-2xl w-full border border-destructive/30 bg-destructive/5 rounded-lg p-6">
          <div className="flex items-center gap-3 mb-4">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <h1 className="text-xl font-semibold">Something broke on this page</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-3">
            A render error crashed the component tree. The specific error is below — send this to
            whoever is helping you debug.
          </p>
          <div className="bg-background border rounded p-3 mb-4 max-h-60 overflow-auto">
            <pre className="text-xs font-mono whitespace-pre-wrap">
              <strong className="text-destructive">{this.state.error.name}:</strong> {this.state.error.message}
              {"\n\n"}
              {this.state.error.stack ?? ""}
            </pre>
          </div>
          <div className="flex gap-2">
            <Button onClick={this.reset} variant="default">Try again</Button>
            <Button onClick={() => (window.location.href = "/")} variant="outline">Go to Dashboard</Button>
          </div>
        </div>
      </div>
    );
  }
}
