<script lang="ts">
import { PinInput as InputOTPPrimitive } from 'bits-ui';
import { cn } from '$lib/utils/shadcn.js';

let {
  ref = $bindable(null),
  // Not in the file shadcn generates. The real focusable control is the hidden input, so a
  // consumer that has to move focus to this field needs a handle on it.
  inputRef = $bindable(null),
  class: className,
  value = $bindable(''),
  ...restProps
}: InputOTPPrimitive.RootProps = $props();
</script>

<InputOTPPrimitive.Root
  bind:ref
  bind:inputRef
  bind:value
  data-slot="input-otp"
  spellcheck={false}
  class={cn(
		"cn-input-otp flex items-center has-disabled:opacity-50",
		// Scoped to the descendant input, unlike the string shadcn/ui generates for React: here
		// the root is a `<div>` and bits-ui merges `restProps` — `disabled` among them — into the
		// `<input>` it renders beside the cells, so the root itself is never `:disabled`.
		"[&_input]:disabled:cursor-not-allowed",
		className
	)}
  {...restProps}
/>
