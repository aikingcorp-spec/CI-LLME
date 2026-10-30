let active = false;

export function isCallActive(): boolean {
  return active;
}

export function setCallActive(value: boolean): void {
  active = value;
}
