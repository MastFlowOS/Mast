# PyInstaller hook override:
# The community pyinstaller-hooks-contrib provides hook-workflow.py for the Alfred 'workflow' library.
# In mast-lead-engine, 'workflow' is our internal module (subsystem 15).
# This empty hook prevents PyInstaller from attempting to import Alfred internals.
