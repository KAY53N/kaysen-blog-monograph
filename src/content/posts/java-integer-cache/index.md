---
title: "Java 中整型的缓存机制"
excerpt: "Integer 内部缓存了 -128 到 127，自动装箱会走这份缓存。上限 127 可以用 -XX:AutoBoxCacheMax 改。Byte、Short、Long 也有类似机制，用 == 比较时要当心。"
category: "Engineering"
date: 2025-01-22
author:
  name: "Kaysen"
  role: "安全与可靠性"
---

Integer 类里有一个内部缓存类，用来省内存、提高性能。它把 -128～127 之间的整型缓存起来，并支持这段区间的自动装箱。最大值 127 可以通过 JVM 启动参数 `-XX:AutoBoxCacheMax=size` 修改。Byte、Short、Long 等类型也有缓存，用的时候要注意。

```java
/**
     * Cache to support the object identity semantics of autoboxing for values between
     * -128 and 127 (inclusive) as required by JLS.
     *
     * The cache is initialized on first usage.  The size of the cache
     * may be controlled by the {@code -XX:AutoBoxCacheMax=<size>} option.
     * During VM initialization, java.lang.Integer.IntegerCache.high property
     * may be set and saved in the private system properties in the
     * sun.misc.VM class.
     */

    private static class IntegerCache {
        static final int low = -128;
        static final int high;
        static final Integer cache[];

        static {
            // high value may be configured by property
            int h = 127;
            String integerCacheHighPropValue =
                sun.misc.VM.getSavedProperty("java.lang.Integer.IntegerCache.high");
            if (integerCacheHighPropValue != null) {
                try {
                    int i = parseInt(integerCacheHighPropValue);
                    i = Math.max(i, 127);
                    // Maximum array size is Integer.MAX_VALUE
                    h = Math.min(i, Integer.MAX_VALUE - (-low) -1);
                } catch( NumberFormatException nfe) {
                    // If the property cannot be parsed into an int, ignore it.
                }
            }
            high = h;

            cache = new Integer[(high - low) + 1];
            int j = low;
            for(int k = 0; k < cache.length; k++)
                cache[k] = new Integer(j++);

            // range [-128, 127] must be interned (JLS7 5.1.7)
            assert IntegerCache.high >= 127;
        }

        private IntegerCache() {}
    }
```

#### 代码：

```java
Integer a=127,b=127;
Integer c=128,d=128;
System.out.println(a==b); // true
System.out.println(c==d); // false
```
