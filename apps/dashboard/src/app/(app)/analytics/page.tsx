"use client";

import { useState } from "react";
import { ChartLine, ArrowSquareOut } from "@phosphor-icons/react";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import { Button } from "@/components/ui/button";

export default function AnalyticsPage() {
  const [requested, setRequested] = useState(false);

  function requestFeature() {
    track({ name: "feature.requested", properties: { feature: "analytics" } });
    setRequested(true);
    toast.success("Got it. We'll bump analytics up the queue.");
  }

  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="size-12 rounded-full bg-muted/60 grid place-items-center mb-4">
        <ChartLine className="size-6 text-muted-foreground" />
      </div>
      <h1 className="text-lg font-semibold">Analytics — coming soon</h1>
      <p className="text-sm text-muted-foreground max-w-md mt-2">
        Per-platform reach, engagement, and post-success metrics — wired
        through the same webhook stream that powers Logs today. Not the
        wedge for v1, so it ships after we've shored up the publishing
        surface.
      </p>
      <div className="flex items-center gap-2 mt-6">
        <Button
          onClick={requestFeature}
          disabled={requested}
          size="sm"
        >
          {requested ? "Vote counted" : "I want this — prioritize it"}
        </Button>
        <Button asChild variant="ghost" size="sm">
          <a
            href="https://docs.letmepost.dev/webhooks"
            target="_blank"
            rel="noopener noreferrer"
          >
            Read webhooks docs
            <ArrowSquareOut className="size-3 ml-1" />
          </a>
        </Button>
      </div>
    </div>
  );
}
