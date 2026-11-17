import { createContext, useContext } from 'react';

// Hidden settings sections stay mounted so ordinary editing drafts survive.
// Secret owners use this signal to discard only their sensitive drafts.
export const SettingsVisibilityContext = createContext(true);
export const useSettingsVisible = () => useContext(SettingsVisibilityContext);
