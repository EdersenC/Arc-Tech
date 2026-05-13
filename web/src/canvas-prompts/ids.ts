export function promptBoxElementId(promptId: string): string {
  return `arc-prompt-${promptId}-box`;
}

export function promptTextElementId(promptId: string): string {
  return `arc-prompt-${promptId}-text`;
}

export function promptCommandElementId(promptId: string): string {
  return `arc-prompt-${promptId}-command`;
}

export function promptLinkElementId(linkId: string): string {
  return `arc-prompt-link-${linkId}`;
}
