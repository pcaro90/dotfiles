#!/bin/sh

# ----------------------------------------------------------------------
# Copyright (c) 2014 Pablo Caro. All Rights Reserved.
# Pablo Caro <me@pcaro.es> - https://pcaro.es/
# colorscheme.sh
# ----------------------------------------------------------------------

color00="12/12/12" # Black - 233
color01="d7/5f/5f" # Red - 167
color02="87/af/5f" # Green - 107
color03="ff/d7/5f" # Yellow - 221
color04="5f/87/ff" # Blue - 68
color05="af/5f/af" # Magenta - 133
color06="87/d7/ff" # Cyan - 117
color07="d7/d7/d7" # White - 188
color08="3a/3a/3a" # Bright Black - 237
color09=$color01 # Bright Red
color10=$color02 # Bright Green
color11=$color03 # Bright Yellow
color12=$color04 # Bright Blue
color13=$color05 # Bright Magenta
color14=$color06 # Bright Cyan
color15="e4/e4/e4" # Bright White - 254

if [ -n "$TMUX" ]; then
  # tell tmux to pass the escape sequences through
  # (Source: http://permalink.gmane.org/gmane.comp.terminal-emulators.tmux.user/1324)
  printf_template="\033Ptmux;\033\033]4;%d;rgb:%s\007\033\\"
elif [ "${TERM%%-*}" = "screen" ]; then
  # GNU screen (screen, screen-256color, screen-256color-bce)
  printf_template="\033P\033]4;%d;rgb:%s\007\033\\"
else
  printf_template="\033]4;%d;rgb:%s\033\\"
fi

printf $printf_template 0  $color00
printf $printf_template 1  $color01
printf $printf_template 2  $color02
printf $printf_template 3  $color03
printf $printf_template 4  $color04
printf $printf_template 5  $color05
printf $printf_template 6  $color06
printf $printf_template 7  $color07
printf $printf_template 8  $color08
printf $printf_template 9  $color09
printf $printf_template 10 $color10
printf $printf_template 11 $color11
printf $printf_template 12 $color12
printf $printf_template 13 $color13
printf $printf_template 14 $color14
printf $printf_template 15 $color15

unset printf_template
unset color00
unset color01
unset color02
unset color03
unset color04
unset color05
unset color06
unset color07
unset color08
unset color09
unset color10
unset color11
unset color12
unset color13
unset color14
unset color15
