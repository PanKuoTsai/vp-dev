# Applying one of VP Studio's patches to a source tree. Sourced by build-qbox.sh.
#
#   vp_apply_patch TREE PATCH LABEL
#
# TREE is a git working tree (QBox, or libqemu's sources), PATCH the patch
# file, LABEL what to call it in the messages. Three cases:
#
#   applied already     nothing to do
#   not applied         git apply
#   partly there        an earlier version of this patch is applied: VP Studio
#                       was updated and the patch changed. Each file is brought
#                       to this version on its own, so the changes other
#                       patches made to the same file stay:
#                         - a file that is as the patch leaves it: kept
#                         - a file the patch still applies to: applied
#                         - a file the patch adds, that is there with other
#                           content and is not QBox's own (untracked): replaced;
#                           the old one goes to TREE/build/vp-studio-replaced/
#                         - anything else: an error, nothing more is changed
#
# Returns 0 when the tree has the patch afterwards, 1 with a message otherwise.

# The files a patch touches, one a line, in its order.
vp_patch_files() {
  sed -n 's|^+++ b/||p' "$1"
}

# Whether the patch adds the file ($2) rather than changing it.
vp_patch_adds() {
  grep -B1 -Fx -- "+++ b/$2" "$1" | head -n 1 | grep -qx -- '--- /dev/null'
}

vp_apply_patch() {
  local tree="$1" patch="$2" label="$3" file kept
  if git -C "$tree" apply --reverse --check "$patch" 2>/dev/null; then
    echo "== patch already applied: $label"
    return 0
  fi
  if git -C "$tree" apply --check "$patch" 2>/dev/null; then
    echo "== applying $label"
    git -C "$tree" apply "$patch"
    return $?
  fi
  # Neither: first see that every file can be brought to this version, then change them.
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    git -C "$tree" apply --reverse --check --include="$file" "$patch" 2>/dev/null && continue
    git -C "$tree" apply --check --include="$file" "$patch" 2>/dev/null && continue
    if vp_patch_adds "$patch" "$file" && [ -f "$tree/$file" ] && ! git -C "$tree" ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
      continue
    fi
    echo "== cannot apply $label" >&2
    echo "It does not apply to $file, and that is not a file an earlier version of the patch added." >&2
    echo "Nothing was changed. Put $tree back as its repository has it (git checkout, and remove the files VP Studio's patches added), then build again." >&2
    return 1
  done < <(vp_patch_files "$patch")
  echo "== updating $label (an earlier version of it is applied)"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    git -C "$tree" apply --reverse --check --include="$file" "$patch" 2>/dev/null && continue
    if ! git -C "$tree" apply --check --include="$file" "$patch" 2>/dev/null; then
      kept="$tree/build/vp-studio-replaced/$file"
      mkdir -p "$(dirname "$kept")"
      mv -f "$tree/$file" "$kept"
      echo "   replaced $file (the earlier one is kept as build/vp-studio-replaced/$file)"
    else
      echo "   applied to $file"
    fi
    git -C "$tree" apply --include="$file" "$patch" || return 1
  done < <(vp_patch_files "$patch")
  return 0
}
