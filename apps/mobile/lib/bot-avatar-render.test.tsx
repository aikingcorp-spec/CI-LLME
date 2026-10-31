// @vitest-environment jsdom

import { avatarIdentitySeed, organicAvatarPath, shippedBotAvatarShapePath } from "@rakazo/core";
import { botEyeColor } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotAvatarProps } from "../components/bot-avatar";
import { BotAvatar } from "../components/bot-avatar";

const nativeProps = vi.hoisted(() => [] as Array<() => Record<string, unknown>>);
const nativeMotion = vi.hoisted(() => ({
  reduced: true,
  styles: [] as Array<() => { transform: unknown[] }>,
  timings: [] as number[],
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  Pressable: ({
    children,
    onPress,
    accessible,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessible?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "data-accessible": String(accessible) },
      children,
    ),
  Image: ({ source }: { source: number | string | { uri: string } }) =>
    createElement("img", { src: typeof source === "object" ? source.uri : source }),
}));

vi.mock("react-native-reanimated", () => {
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    default: {
      View: passthrough,
      createAnimatedComponent: (component: unknown) => component,
    },
    cancelAnimation: () => undefined,
    Easing: { linear: (value: number) => value, inOut: (value: unknown) => value, cubic: 0 },
    ReduceMotion: { Never: "never" },
    withSpring: (value: unknown) => value,
    useAnimatedProps: (sample: () => Record<string, unknown>) => {
      nativeProps.push(sample);
      return {};
    },
    useDerivedValue: (sample: () => unknown) => ({ value: sample() }),
    useAnimatedStyle: (sample: () => { transform: unknown[] }) => {
      nativeMotion.styles.push(sample);
      return {};
    },
    useReducedMotion: () => nativeMotion.reduced,
    useSharedValue: <T,>(value: T) => useRef({ value }).current,
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown, options?: { duration: number }) => {
      const duration = options?.duration ?? 0;
      nativeMotion.timings.push(duration);
      return value === 1 && duration > 0 && duration < 1000 ? 0.4 : value;
    },
  };
});

vi.mock("react-native-svg", () => {
  const element =
    (tag: string) =>
    ({
      children,
      ...props
    }: {
      children?: ReactNode;
      d?: string;
      fill?: string;
      stopColor?: string;
    }) =>
      createElement(
        tag,
        { "data-d": props.d, "data-fill": props.fill, "data-stop-color": props.stopColor },
        children,
      );
  return {
    default: element("svg"),
    Ellipse: element("ellipse"),
    G: element("g"),
    Path: element("path"),
    Rect: element("rect"),
    Defs: element("defs"),
    ClipPath: element("clipPath"),
    Mask: element("mask"),
    LinearGradient: element("linearGradient"),
    RadialGradient: element("radialGradient"),
    Stop: element("stop"),
  };
});

vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    background: "#FFF",
    foreground: "#141414",
    sidebar: "#F1F1F1",
    border: "#CCCCCC",
    workingDot: "#3FA266",
    secondary: "#7676801F",
  }),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

describe("BotAvatar", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    nativeProps.length = 0;
    nativeMotion.styles.length = 0;
    nativeMotion.timings.length = 0;
  });

  function render(
    color: string,
    avatarSet?: "organic" | "rakazo",
    props: Partial<BotAvatarProps> = {},
  ) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <BotAvatar color={color} avatarSet={avatarSet} identity="bot-1" size={42} {...props} />,
      ),
    );
    return container;
  }
  const bodies = (view: HTMLElement) =>
    Array.from(view.querySelectorAll("path"), (path) => path.dataset.d);

  it("uses the full owner image for the legacy set", () => {
    const view = render("#3EC5A8", "rakazo");
    expect(view.querySelector("img")).not.toBeNull();
    expect(bodies(view)).toEqual([]);
  });

  it("keeps a custom picture when the stored set is legacy", () => {
    const view = render("data:image/png;base64,abc", "rakazo");
    expect(view.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
  });

  it("keeps a shape picked in Avatar Studio", () => {
    const view = render("#8B5CF6::shape_3", "rakazo");
    expect(bodies(view)).toEqual([shippedBotAvatarShapePath(3)]);
  });

  it("keeps plain-colour organic avatars", () => {
    const view = render("#3EC5A8");
    expect(bodies(view)).toEqual([organicAvatarPath(avatarIdentitySeed("bot-1"))]);
    expect(Array.from(view.querySelectorAll("rect"), (eye) => eye.dataset.fill)).toEqual([
      botEyeColor,
      botEyeColor,
    ]);
  });
});
