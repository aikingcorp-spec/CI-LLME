import { Input as InputPrimitive } from "@base-ui/react/input";
import { Button } from "@rakazo/ui-web/components/ui/button";
import {
  InputRevealLabelsProvider,
  RevealLabelsContext,
} from "@rakazo/ui-web/components/ui/input-reveal-labels";
import { inputClass } from "@rakazo/ui-web/components/ui/input-variants";
import { cn } from "@rakazo/ui-web/lib/utils";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";

type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  size?: "default" | "xl";
};

function Input({ className, type, size = "default", ...props }: InputProps) {
  if (type === "password") return <HiddenInput className={className} size={size} {...props} />;
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(inputClass, className)}
      {...props}
    />
  );
}

/**
 * A field whose value is hidden, with a button that shows it. The caller's classes go on the
 * input like any other field. The input is a block, so its margins pass through the wrapper and
 * the button stays centred on the field.
 */
function HiddenInput({ className, size, disabled, ...props }: Omit<InputProps, "type">) {
  const labels = React.useContext(RevealLabelsContext);
  const [shown, setShown] = React.useState(false);
  // Disabling the field, say while a form submits, hides the value again, and it stays hidden
  // when the field is enabled again.
  if (disabled && shown) setShown(false);
  const visible = shown && !disabled;
  return (
    <div data-slot="input-reveal" className="relative w-full min-w-0">
      <InputPrimitive
        type={visible ? "text" : "password"}
        data-slot="input"
        data-size={size}
        disabled={disabled}
        className={cn(inputClass, "block", className, "pr-9 data-[size=xl]:pr-12")}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size={size === "xl" ? "icon" : "icon-sm"}
        disabled={disabled}
        aria-label={visible ? labels.hide : labels.show}
        // A click leaves the caret in the field; the keyboard still reaches the button.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setShown((current) => !current)}
        className={cn(
          "absolute inset-y-0 my-auto text-muted-foreground",
          size === "xl" ? "right-2" : "right-1",
        )}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </div>
  );
}

export { Input, InputRevealLabelsProvider };
