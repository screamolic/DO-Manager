import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Power, RotateCw, Terminal, Play, Square } from "lucide-react";
import { toast } from "sonner";

export function QuickActionDropdown({ serverId }: { serverId: number }) {
  const actions = [
    { label: "Power Cycle", icon: Power, action: "power_cycle" },
    { label: "Reboot", icon: RotateCw, action: "reboot" },
    { label: "Shutdown", icon: Terminal, action: "shutdown" },
    { label: "Power On", icon: Play, action: "power_on" },
    { label: "Power Off", icon: Square, action: "power_off" },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((a) => (
          <DropdownMenuItem
            key={a.action}
            onClick={() => toast.info(`Action "${a.label}" queued for server #${serverId}`)}
          >
            <a.icon className="mr-2 h-4 w-4" />
            {a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
