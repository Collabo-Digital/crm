/**
 * Google's picker, for choosing an existing sheet. Picking it is what gives
 * Collabo access to it under the drive.file scope. Needs the browser API key
 * and the Google Cloud project number (VITE_GOOGLE_PICKER_API_KEY,
 * VITE_GOOGLE_APP_ID); without them only "Create a sheet" is offered.
 */
const API_KEY = import.meta.env.VITE_GOOGLE_PICKER_API_KEY as string | undefined;
const APP_ID = import.meta.env.VITE_GOOGLE_APP_ID as string | undefined;

export const pickerAvailable = !!(API_KEY && APP_ID);

interface PickerDoc {
  id: string;
  name: string;
}

interface PickerApi {
  ViewId: { SPREADSHEETS: string };
  DocsViewMode: { LIST: string };
  Action: { PICKED: string; CANCEL: string };
  DocsView: new (viewId: string) => { setMode(mode: string): unknown };
  PickerBuilder: new () => PickerBuilder;
}

interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(cb: (data: { action: string; docs?: PickerDoc[] }) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

declare global {
  interface Window {
    gapi?: { load(name: string, done: () => void): void };
    google?: { picker?: PickerApi };
  }
}

function loadPicker(): Promise<PickerApi> {
  return new Promise((resolve, reject) => {
    const ready = () => window.gapi!.load("picker", () => (window.google?.picker ? resolve(window.google.picker) : reject(new Error("Google's picker did not load."))));
    if (window.gapi) return ready();
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = ready;
    script.onerror = () => reject(new Error("Google's picker could not be loaded. Check your network."));
    document.body.appendChild(script);
  });
}

/** Opens the picker on the person's spreadsheets; resolves with the one they chose, or null. */
export async function pickSpreadsheet(accessToken: string): Promise<PickerDoc | null> {
  const picker = await loadPicker();
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.SPREADSHEETS);
    // List mode: with drive.file the picker has no access to thumbnails.
    view.setMode(picker.DocsViewMode.LIST);
    new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(API_KEY!)
      .setAppId(APP_ID!)
      .setTitle("Choose a sheet for Collabo")
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED && data.docs?.[0]) resolve({ id: data.docs[0].id, name: data.docs[0].name });
        else if (data.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
