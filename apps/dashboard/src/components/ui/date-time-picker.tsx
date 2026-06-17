"use client";

import * as React from "react";
import { Calendar as CalendarIcon, Clock } from "@phosphor-icons/react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type DateTimePickerProps = {
  value: Date | null;
  onChange: (value: Date) => void;
  minDate?: Date;
  placeholder?: string;
  className?: string;
};

export function DateTimePicker({
  value,
  onChange,
  minDate,
  placeholder = "Pick a date & time",
  className,
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false);

  const hour = value ? value.getHours() : 9;
  const minute = value ? value.getMinutes() : 0;

  function handleDateSelect(d: Date | undefined) {
    if (!d) return;
    const next = new Date(d);
    next.setHours(hour, minute, 0, 0);
    onChange(next);
  }

  function handleHourChange(h: number) {
    const base = value ?? new Date();
    const next = new Date(base);
    next.setHours(h, minute, 0, 0);
    onChange(next);
  }

  function handleMinuteChange(m: number) {
    const base = value ?? new Date();
    const next = new Date(base);
    next.setHours(hour, m, 0, 0);
    onChange(next);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-full justify-start text-left font-normal tabular-nums",
            !value && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="size-4" />
          {value
            ? format(value, "EEE, MMM d · h:mm a")
            : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value ?? undefined}
          onSelect={handleDateSelect}
          disabled={minDate ? { before: minDate } : undefined}
          autoFocus
        />
        <div className="border-t p-3 flex items-center gap-2">
          <Clock className="size-4 text-muted-foreground shrink-0" />
          <select
            value={hour}
            onChange={(e) => handleHourChange(Number(e.target.value))}
            className="bg-background rounded-md ring-1 ring-foreground/10 px-2 py-1 text-sm tabular-nums focus:ring-foreground/20 outline-none"
          >
            {Array.from({ length: 24 }, (_, i) => i).map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground">:</span>
          <select
            value={minute}
            onChange={(e) => handleMinuteChange(Number(e.target.value))}
            className="bg-background rounded-md ring-1 ring-foreground/10 px-2 py-1 text-sm tabular-nums focus:ring-foreground/20 outline-none"
          >
            {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
              <option key={m} value={m}>
                {String(m).padStart(2, "0")}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => setOpen(false)}
          >
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
