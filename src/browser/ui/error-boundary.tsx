import { Component, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a render-time throw from taking down the whole app. Without one, a
 * single bad value anywhere unmounts the entire tree and the user gets a blank
 * page with nothing to act on — which has twice been the hardest kind of bug
 * to diagnose, since there is no error on screen and the console is the only
 * clue.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled error in app:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex items-center justify-center p-6">
        <div className="max-w-lg w-full rounded-md border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
            <h2 className="text-sm font-semibold">Something went wrong</h2>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            The app hit an unexpected error. Reloading usually clears it; if it
            keeps happening, the details are in the browser console.
          </p>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded border border-border bg-muted/50 p-2 text-xs font-mono text-muted-foreground">
            {error.message}
          </pre>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="rounded border border-border px-2 py-1 text-xs hover:bg-muted transition-colors"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded border border-border px-2 py-1 text-xs hover:bg-muted transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
