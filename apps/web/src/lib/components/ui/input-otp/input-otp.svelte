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
		"disabled:cursor-not-allowed",
		className
	)}
  {...restProps}
/>
