#!/usr/bin/env bash

# ---------------------------------------------------
# Copyright (c) 2013 Pablo Caro. All Rights Reserved.
# Pablo Caro <pablo@pcaro.es> - http://pcaro.es/
# install.sh
# ---------------------------------------------------

function backup {
    echo -n "        "
    mv -Tvf $HOME/.$1 $HOME/.$1.bak
}

function link {
    echo -n "        "
    if [ $2 ] ; then
        ln -vfs `pwd`/$2/$1 $HOME/.$1
    else
        ln -vfs `pwd`/$1 $HOME/.$1
    fi
}

function install_file {
    echo "    - Installing $1 -"
    if [ -f $HOME/.$1 ] ; then
        echo "        A .$1 file exists in your home folder."
        echo "        Saving backup as .$1.bak"
        backup $1
        echo
    fi

    echo "        Linking $1"
    link $1 $2
    echo
}

function install_folder {
    echo "    - Installing $1 -"
    if [ -d $HOME/.$1 ] ; then
        echo "        A .$1 file exists in your home folder."
        echo "        Saving backup as .$1.bak"
        backup $1
        echo
    fi

    echo "        Linking $1"
    link $1
    echo
}

function merge_folder {
    echo "    - Merging $1 -"
    if [ ! -d $HOME/$1 ] ; then
        mkdir $1
    fi

    for file in `ls $1` ; do
        echo "        Linking file"
        echo -n "        "
        ln -sfv $1/$file $HOME/$1/$file
        echo
    done

}

function install_bash {
    echo "= Installing bash configuration files ="
    echo "======================================="

    folder="bash"

    # Bash configuration
    install_file "bashrc" $folder

    # Bash alias definition
    install_file "bash_alias" $folder

}

function install_git {
    echo "= Installing git configuration files ="
    echo "======================================"

    folder="git"

    # Git configuration
    install_file "gitconfig" $folder

    # Git global ignore list
    install_file "gitignore_global" $folder

}

function install_vim {
    echo "= Installing vim configuration files ="
    echo "======================================"

    folder="vim"

    # Vim files folder
    install_folder "vim"

    # Vim config
    install_file "vimrc" $folder

    # Vim extra folders
    mkdir vim/tmp
    mkdir vim/bundle

    # Install Vundle
    git clone https://github.com/gmarik/vundle `pwd`/vim/bundle/vundle

    # Check vim instalation
    if [ `which vim` ] ; then
        # Bundles instalation and activation
        vim +BundleInstall +qall
    else
        echo "WARNING: Vim not installed."
    fi

}

function install_others {
    echo "= Installing other files ="
    echo "=========================="

    folder="others"

    # Adding bin
    merge_folder "bin"

    # Installing ack (to home, not to dotfiles)
    echo "    - Downloading ack -"
    ack=$HOME/bin/ack
    curl http://beyondgrep.com/ack-2.04-single-file > $ack && chmod 0755 $ack

    # Ack configuration
    install_file "ackrc" $folder

}

install_bash
install_git
install_vim
install_others
