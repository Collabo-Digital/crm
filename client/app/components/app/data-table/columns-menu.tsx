import { Columns3 } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

import { visibleColumns } from "./column";
import type { DataTableState } from "./use-data-table-state";

/** Minimum columns that must stay on; below this a table stops being one. */
const MIN_VISIBLE = 3;

export function ColumnsMenu<Row>({ state }: { state: DataTableState<Row> }) {
  const { config, hidden, setHidden, resetHidden, isDefaultHidden } = state;
  const visibleCount = visibleColumns(config.columns, hidden).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-11 rounded-xl md:h-8 md:rounded-lg">
          <Columns3 />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">
          Show columns
        </DropdownMenuLabel>
        {config.columns.map((column) => {
          const on = column.locked || !hidden[column.key];
          const disabled = Boolean(column.locked) || (on && visibleCount <= MIN_VISIBLE);
          return (
            <DropdownMenuCheckboxItem
              key={column.key}
              checked={on}
              disabled={disabled}
              // Stays open: ticking columns is a batch, not a command.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => {
                const next = { ...hidden };
                if (checked) delete next[column.key];
                else next[column.key] = true;
                setHidden(next);
              }}
            >
              <span className="flex-1">{column.label}</span>
              {column.locked && (
                <span className="ml-auto text-micro text-muted-foreground">Always shown</span>
              )}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={isDefaultHidden}
          onSelect={resetHidden}
          className="text-muted-foreground"
        >
          Reset to default
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
