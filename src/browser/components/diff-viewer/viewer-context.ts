import { createContext } from "react";
import type { DiffRow } from "../../lib/file-diff";
import type { CommentLayout } from "./annotations";

/**
 * The comments behind the viewer's annotations. Annotations only carry keys
 * (so Pierre does not re-render the diff when a comment changes); the content
 * reads the live threads and pending comments from here.
 */
export const CommentLayoutContext = createContext<CommentLayout | null>(null);

/** Rows of the diff as Pierre currently shows them (expansion included). */
export const DiffRowsContext = createContext<readonly DiffRow[] | null>(null);
