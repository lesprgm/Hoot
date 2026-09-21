import type { ContextReference, ContextSnapshot } from "../../shared/types";

export interface RegisteredObject extends ContextReference {
  valid: boolean;
  invalidReason?: string;
}

/** Keeps context targets re-checkable without treating screen coordinates as identity. */
export class ObjectRegistry {
  private objects = new Map<string, RegisteredObject>();

  update(snapshot: ContextSnapshot): void {
    const seen = new Set<string>();
    for (const reference of snapshot.references) {
      seen.add(reference.id);
      this.objects.set(reference.id, { ...reference, valid: snapshot.access === "active" });
    }
    for (const [id, object] of this.objects) {
      if (!seen.has(id) && object.source !== "task") this.objects.set(id, { ...object, valid: false, invalidReason: "Reference is no longer visible." });
    }
  }

  register(reference: ContextReference): RegisteredObject {
    const value = { ...reference, valid: true };
    this.objects.set(reference.id, value);
    return value;
  }

  get(id: string): RegisteredObject | null {
    return this.objects.get(id) ?? null;
  }

  revalidate(id: string, expectedRevision?: string): { ok: true; object: RegisteredObject } | { ok: false; reason: string } {
    const object = this.get(id);
    if (!object) return { ok: false, reason: "Reference is not registered." };
    if (!object.valid) return { ok: false, reason: object.invalidReason ?? "Reference is no longer valid." };
    if (expectedRevision && object.revision && expectedRevision !== object.revision) return { ok: false, reason: "Reference revision changed." };
    return { ok: true, object };
  }

  clear(): void {
    this.objects.clear();
  }
}

