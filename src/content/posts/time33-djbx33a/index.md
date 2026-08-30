---
title: "time33 哈希"
excerpt: "很出名的 times 33 哈希，也叫 DJBX33A。算得快，字符串做键时分布也不错。Perl 用过，Berkeley DB 里也能见到。乘数为什么是 33，Ralf S. Engelschall 有一段常被引用的解释。"
category: "Engineering"
date: 2026-08-28
author:
  name: "Kaysen"
  role: "安全与可靠性"
---

## 0x00 介绍

这是很出名的 times 33 哈希，也叫 DJBX33A（Daniel J. Bernstein, Times 33 with Addition）。Perl 用过，Berkeley DB 里也能见到。处理以字符串为键的哈希时，计算很快，分布也比较均匀，冲突相对少。它不是密码学哈希，只适合普通哈希表。

## 0x01 算法代码

```c
uint32_t time33(char const *str, int len)
{
    unsigned long hash = 0;
    for (int i = 0; i < len; i++) {
        hash = hash * 33 + (unsigned long)str[i];
    }
    return hash;
}
```

`hash * 33` 可以换成移位：`33 = 32 + 1`，也就是 `(hash << 5) + hash`。

```c
unsigned long time33(char const *str, int len)
{
    unsigned long hash = 0;
    for (int i = 0; i < len; i++) {
        hash = ((hash << 5) + hash) + (unsigned long)str[i];
    }
    return hash;
}
```

## 0x02 为什么是 33？

```
DJBX33A (Daniel J. Bernstein, Times 33 with Addition)

This is Daniel J. Bernstein's popular `times 33' hash function as
posted by him years ago on comp.lang.c. It basically uses a function
like ``hash(i) = hash(i-1) * 33 + str[i]''. This is one of the best
known hash functions for strings. Because it is both computed very
fast and distributes very well.

The magic of number 33, i.e. why it works better than many other
constants, prime or not, has never been adequately explained by
anyone. So I try an explanation: if one experimentally tests all
multipliers between 1 and 256 (as RSE did now) one detects that even
numbers are not useable at all. The remaining 128 odd numbers
(except for the number 1) work more or less all equally well. They
all distribute in an acceptable way and this way fill a hash table
with an average percent of approx. 86%.

If one compares the Chi^2 values of the variants, the number 33 not
even has the best value. But the number 33 and a few other equally
good numbers like 17, 31, 63, 127 and 129 have nevertheless a great
advantage to the remaining numbers in the large set of possible
multipliers: their multiply operation can be replaced by a faster
operation based on just one shift plus either a single addition
or subtraction operation. And because a hash function has to both
distribute good _and_ has to be very fast to compute, those few
numbers should be preferred and seems to be the reason why Daniel J.
Bernstein also preferred it.

                 -- Ralf S. Engelschall <rse@engelschall.com>
```
