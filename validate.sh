#!/bin/bash
set -u
cd "$HOME/Widgets in Gnome" || exit 1

fail=0
echo "== Recompilando esquemas =="
if glib-compile-schemas schemas/; then
    echo "gschemas OK"
else
    echo "gschemas FALLO"
    fail=1
fi

echo
echo "== Sintaxis JS (node --check como ESM) =="
for f in extension.js prefs.js core/*.js ui/*.js widgets/*.js; do
    tmp="/tmp/syntax-check.mjs"
    cp "$f" "$tmp"
    if node --check "$tmp" 2>/tmp/syntax-err.txt; then
        echo "OK   $f"
    else
        echo "FALLO $f"
        cat /tmp/syntax-err.txt
        fail=1
    fi
done

echo
echo "== Traducciones gettext =="
if msgfmt --check --check-format -o locale/es/LC_MESSAGES/widgets@kin.mo po/es.po && msgcmp po/es.po po/widgets@kin.pot; then
    echo "gettext OK"
else
    echo "gettext FALLO"
    fail=1
fi

echo
echo "== Iconos =="
ls icons/*.svg | wc -l

exit $fail