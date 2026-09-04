import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Merge extra classes onto a bits-ui `child` snippet's `props`, for a component that renders
 * its own element in place of the primitive's (`{#snippet child({ props })}<a {...props} ...>`).
 *
 * `props` is typed `Record<string, unknown>` — bits-ui can't know its own primitive puts a
 * class string there, only that it does — so `props.class` needs the cast this centralizes.
 * Skipping this and writing a literal `class="..."` after `{...props}` compiles fine but
 * silently discards whatever class the primitive put there, including its interaction states
 * (`hover:`/`focus:`/...), because a literal attribute after a spread wins over the spread.
 */
export function cnChildProps(props: Record<string, unknown>, ...inputs: ClassValue[]) {
  return cn(props.class as ClassValue, ...inputs);
}

export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T;
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
