import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { formatDateTimeSeconds, getTimeAgo } from "../lib/dates";

// ============================================================================
// Relative Timestamp
// ============================================================================

/** Relative time ("1d ago") revealing the exact timestamp on hover. */
export function TimeAgo({
  date,
  className,
}: {
  date: Date;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className}>{getTimeAgo(date)}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {formatDateTimeSeconds(date)}
      </TooltipContent>
    </Tooltip>
  );
}
