import * as React from "react";
import { Slot as SlotPrimitive } from "radix-ui";

// A ref that BlockLink.Root uses to know where its BlockLink.Link is. Root
// clicks are re-dispatched onto this element so the browser handles them as
// native <a> activation.
type BlockLinkContextValue = {
  linkRef: React.RefObject<HTMLElement | null>;
};

const BlockLinkContext = React.createContext<BlockLinkContextValue | null>(
  null
);

type RootProps = Omit<React.HTMLAttributes<HTMLDivElement>, "onClick"> & {
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  children: React.ReactNode;
  asChild?: boolean;
};

function Root({ onClick, children, asChild, ...props }: RootProps) {
  const linkRef = React.useRef<HTMLElement | null>(null);

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      onClick?.(e);
      if (e.defaultPrevented) return;
      const link = linkRef.current;
      if (link && !link.contains(e.target as Node)) {
        link.click();
      }
    },
    [onClick]
  );

  const Comp = asChild ? SlotPrimitive.Slot : "div";

  return (
    <BlockLinkContext.Provider value={{ linkRef }}>
      <Comp onClick={handleClick} {...props}>
        {children}
      </Comp>
    </BlockLinkContext.Provider>
  );
}

type LinkOwnProps = {
  asChild?: boolean;
  children: React.ReactNode;
};

type LinkProps = LinkOwnProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkOwnProps>;

function Link({ asChild, children, onClick, ...props }: LinkProps) {
  const context = React.useContext(BlockLinkContext);
  const localRef = React.useRef<HTMLElement | null>(null);

  const setRef = React.useCallback(
    (el: HTMLElement | null) => {
      localRef.current = el;
      if (context) context.linkRef.current = el;
    },
    [context]
  );

  const handleClick = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    onClick?.(e as React.MouseEvent<HTMLAnchorElement>);
  };

  const Comp = asChild ? SlotPrimitive.Slot : "a";
  return (
    <Comp ref={setRef} onClick={handleClick} {...props}>
      {children}
    </Comp>
  );
}

export const BlockLink = { Root, Link };
