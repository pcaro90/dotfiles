Pablo Caro's dotfiles
=====================

These are the configuration files I use in Linux and OS X to feel like home
everywhere. They include personalizations to vim, bash, git, and some other
stuff I like. Usually, everything that is not obvious or auto descriptive is
reasonably well commented.

Everything is linked to its place, not copied. The `bin` folder, instead, is
merged: files inside `dotfiles/bin` are linked into `~/bin`, but existing files
in the `~/bin` folder will be kept. In any other case, existing files and
folders will be renamed to `.whatever.bak` and replaced.

Install
-------

    cd
    git clone https://github.com/pcaro90/dotfiles.git
    dotfiles/install.sh

Vim
---

Vim files are inside the `vim` folder. The `vimrc` file is well explained, and
with folding markers dividing the file in categories. I use the fantastic
[Vundle][] to manage the plugins I have installed. The _Vundle Configuration_
category lists and briefly explains all the plugins.

Note that some plugins (like [Syntastic][]) require additional software to work
properly, which is not automatically installed.

License
-------

Copyright (c) 2013 Pablo Caro. All Rights Reserved.

Pablo Caro <<me@pcaro.es>> - <http://pcaro.es/>

See LICENSE file.

[Vundle]: https://github.com/gmarik/vundle
[Syntastic]: https://github.com/scrooloose/syntastic
