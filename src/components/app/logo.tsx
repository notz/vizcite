import { cn } from "@/lib/utils";

export function LogoMark({ className, src }: { className?: string; src?: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className={cn("size-7 rounded-lg object-contain", className)} />;
  }
  return (
    <svg viewBox="0 0 64 64" fill="none" className={cn("size-7", className)} aria-hidden>
      <rect width="64" height="64" rx="16" className="fill-foreground" />
      <path d="M17 16 L32 46" className="stroke-background" strokeWidth="10" strokeLinecap="round" />
      <path d="M47 16 L32 46" stroke="#818cf8" strokeWidth="10" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ name, src, className }: { name: string; src?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <LogoMark src={src} />
      <span className="truncate">{name}</span>
    </span>
  );
}
